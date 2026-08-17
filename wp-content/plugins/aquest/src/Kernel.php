<?php
namespace AQ;

/**
 * THE REPRODUCIBILITY CHECKLIST — the whole publication gate (operator order 2026-07-28).
 *
 * The platform used to execute every submission itself, twice, in an offline sandbox, score it on
 * calibrated trade-off axes and put it to a three-seat blind AI panel. All of that is retired. A
 * submission is now ONE thing: the URL of a Kaggle notebook's output page —
 *
 *     https://www.kaggle.com/code/arash0ash/nine-down-ace-step-xl-sft/output
 *
 * — from which the author picks the files they want to publish. Everything the platform asserts
 * about that work is then READ BACK from Kaggle and listed, item by item, in public.
 *
 * WHY THIS IS STRONGER, NOT WEAKER. The old claim was "we ran it on our machine and the bytes
 * matched": unfalsifiable by anyone who is not us. The new claim is a list of facts a stranger can
 * check from their own browser, because — verified 2026-07-28 — `kernels/pull` and `kernels/output`
 * answer 200 with NO credential at all. Our checklist is not a private judgement; it is a public
 * assertion anybody can re-run against the same public API and contradict.
 *
 * WHAT WE DELIBERATELY DO NOT CLAIM. Kaggle enforces the offline condition, not us; we read a flag
 * on a machine we do not own. Nothing is executed twice, so there is no byte-stability claim any
 * more. Say "ran with the internet switched off, on Kaggle's own record" — never "we enforced it".
 *
 * SEVERITY IS BINARY AND HONEST. A check either BLOCKS publication or WARNS. Blocks are reserved
 * for facts that make the run un-repeatable by a stranger (a private input, a needed secret, a run
 * that ended in a crash). Warnings are judgement — surfaced loudly, never in the way. Nothing here
 * is a score, a rank or an opinion: every check names the exact evidence it read.
 *
 * @see Kaggle  the read client, whose docblock records the API traps this class relies on.
 */
class Kernel {

	/** A check that must pass before anything can be published. */
	const BLOCK = 'block';
	/** A check whose failure is shown prominently but never prevents publication. */
	const WARN  = 'warn';

	/** The four groups, in the order an author reads them. */
	const GROUPS = [
		'open'   => 'Can anyone open it?',
		'inputs' => 'Can anyone re-run it?',
		'run'    => 'Did that run produce these files?',
		'rigour' => 'How repeatable is the result?',
	];

	/** Per-file and per-submission ceilings for what may be mirrored into the Library. */
	const MAX_FILE_BYTES  = 536870912;   // 512 MB
	const MAX_TOTAL_BYTES = 1073741824;  // 1 GB
	const MAX_SELECTED    = 24;          // files per submission

	/**
	 * What the Library can serve, by extension → [ media class, mime ].
	 * The class drives how the file renders on a work page, in the Library and inside a post.
	 *
	 * `scene` is SVG, and it is its own class rather than an `image` (measured 2026-07-30). A raster
	 * image is a grid of samples that a card resizes; a scene is a DESCRIPTION that a card re-renders,
	 * and for procedural work that difference is the whole result: a 1080px video of a 9px hairline
	 * shown in a ~430px feed card thins it to 3.6px and loses 58% of the direction signal the effect
	 * depends on, while the same scene in an <img> holds the hairline CONSTANT at every card width and
	 * every devicePixelRatio via vector-effect="non-scaling-stroke". Filing it under `image` would put
	 * it behind poster.png in HERO_ORDER and ship the reader the dead frame instead of the work.
	 *
	 * It is also the ONE published class the browser executes, so it is the one class whose BYTES are
	 * gated, not just its extension — see the svg_safe check in inspect() and Svg::clean() in mirror().
	 */
	const TYPES = [
		'wav'  => [ 'audio', 'audio/wav' ],       'mp3'  => [ 'audio', 'audio/mpeg' ],
		'flac' => [ 'audio', 'audio/flac' ],      'ogg'  => [ 'audio', 'audio/ogg' ],
		'png'  => [ 'image', 'image/png' ],       'jpg'  => [ 'image', 'image/jpeg' ],
		'jpeg' => [ 'image', 'image/jpeg' ],      'webp' => [ 'image', 'image/webp' ],
		'gif'  => [ 'image', 'image/gif' ],
		'svg'  => [ 'scene', 'image/svg+xml' ],   // vector scene — the work itself, not a picture of it
		'mp4'  => [ 'video', 'video/mp4' ],       'webm' => [ 'video', 'video/webm' ],
		'obj'  => [ 'model3d', 'model/obj' ],     'glb'  => [ 'model3d', 'model/gltf-binary' ],
		'stl'  => [ 'model3d', 'model/stl' ],     'ply'  => [ 'model3d', 'model/mesh' ],
		'csv'  => [ 'data', 'text/csv' ],         'parquet' => [ 'data', 'application/vnd.apache.parquet' ],
		'json' => [ 'data', 'application/json' ], 'jsonl'   => [ 'data', 'application/x-ndjson' ],
		'ndjson' => [ 'data', 'application/x-ndjson' ],
		'safetensors' => [ 'weights', 'application/octet-stream' ],
		'onnx' => [ 'weights', 'application/octet-stream' ],
		'pdf'  => [ 'doc', 'application/pdf' ],   'md'   => [ 'doc', 'text/markdown' ],
		'txt'  => [ 'doc', 'text/plain' ],        'html' => [ 'doc', 'text/html' ],
		'ipynb' => [ 'notebook', 'application/x-ipynb+json' ],
	];

	/** Media classes that make a good hero on a work card, best first.
	 *
	 *  `scene` outranks `video`, which is the entire point of the 2026-07-30 change: a work that ships
	 *  scene.svg beside loop.webp and poster.png publishes all three, and the card must lead with the
	 *  one that survives being 430px wide on a phone and 1290px on a desktop. The raster twin stays as
	 *  the OG-card, RSS and reduced-motion fallback — it is a copy of the work, not the work. */
	const HERO_ORDER = [ 'scene', 'video', 'image', 'audio', 'model3d', 'notebook', 'doc', 'data', 'weights' ];

	// ── URL → kernel ──────────────────────────────────────────────────────────

	/** Extension of a path, lowercased, '' when there is none. */
	public static function ext( $name ) {
		$base = strtolower( (string) substr( strrchr( '/' . $name, '/' ), 1 ) );
		$dot  = strrpos( $base, '.' );
		return false === $dot ? '' : substr( $base, $dot + 1 );
	}

	/** The media class of a filename, or '' when the Library cannot serve it. */
	public static function class_of( $name ) {
		$e = self::ext( $name );
		return isset( self::TYPES[ $e ] ) ? self::TYPES[ $e ][0] : '';
	}

	/** The mime we will serve a filename as. */
	public static function mime_of( $name ) {
		$e = self::ext( $name );
		return isset( self::TYPES[ $e ] ) ? self::TYPES[ $e ][1] : 'application/octet-stream';
	}

	// ── Reading the notebook source ───────────────────────────────────────────

	/**
	 * Every line of code + markdown in a kernel's source, as one lowercase string.
	 *
	 * Kaggle hands back either notebook JSON (`blob.source` for kernelType notebook) or a bare
	 * script. Both are searched the same way — the checks below only ever ask "does this text
	 * contain X", never "parse this correctly", so a malformed notebook degrades to a plain-text
	 * scan instead of throwing.
	 */
	public static function source_text( $src ) {
		$src = (string) $src;
		if ( '' === $src ) { return ''; }
		$j = json_decode( $src, true );
		if ( ! is_array( $j ) || ! isset( $j['cells'] ) ) { return strtolower( $src ); }
		$out = '';
		foreach ( (array) $j['cells'] as $c ) {
			$s = $c['source'] ?? '';
			$out .= ( is_array( $s ) ? implode( '', $s ) : (string) $s ) . "\n";
		}
		return strtolower( $out );
	}

	/** [ code cells, total cells ] — a bare script counts as one of each. */
	public static function code_cells( $src ) {
		$j = json_decode( (string) $src, true );
		if ( ! is_array( $j ) || ! isset( $j['cells'] ) ) { return [ 1, 1 ]; }
		$n = 0;
		foreach ( (array) $j['cells'] as $c ) { if ( 'code' === ( $c['cell_type'] ?? '' ) ) { $n++; } }
		return [ $n, count( (array) $j['cells'] ) ];
	}

	/**
	 * Did the run finish? Read from the run log, which is the authoritative record.
	 *
	 * `kernels/status` is 401 for every credential we hold, so this is the only way — and the log
	 * carries a positive marker. Kaggle's runner finishes a notebook by converting it and writing
	 * the rendered result:
	 *
	 *     [NbConvertApp] Writing 305664 bytes to __results__.html
	 *
	 * This verdict is written into a permanent DOI, so it is worth saying exactly what that line does
	 * NOT mean. Two things, both found by attacking the check rather than reading it:
	 *
	 * 1. IT IS NOT PROOF THE NOTEBOOK SUCCEEDED. Kaggle runs nbconvert even after papermill has
	 *    declared the notebook dead, so a CRASHED run's log can still END with the marker — no
	 *    forgery required. `yassineghouzam/titanic-top-4-with-ensemble-modeling` is the live case
	 *    (re-checkable with no credential): it dies at `Exception encountered at "In [13]"`, and its
	 *    final log event is nonetheless `[NbConvertApp] Writing 450831 bytes to __results__.html`.
	 *    Matching the marker anywhere — or even only at the end — certifies that crash. So
	 *    papermill's own verdict is read first, and it is decisive.
	 *
	 * 2. STDERR IS NOT AUTHOR-FREE. The note that used to sit here claimed a notebook's output goes
	 *    to stdout, so stderr could be trusted. That is false: Kaggle labels `tqdm` progress bars,
	 *    `warnings.warn()` and any `print(file=sys.stderr)` as stderr, so an author can write
	 *    whatever they like into the stream this check reads. Splitting the streams only removes the
	 *    laziest forgery. What costs something is POSITION — the marker must be in the LAST stderr
	 *    event, which a notebook cannot reach, because whatever it writes the runner writes after
	 *    it. Verified against fourteen public kernels (thirteen healthy, one crashed): in every one
	 *    the marker sits in the final stderr event with nothing after it, and in two of them that
	 *    event is several lines long with the marker as its last line — so it is matched WITHIN the
	 *    final event, not required to be the whole of it.
	 *
	 * A NAIVE TRACEBACK SCAN IS ALSO WRONG, and this was caught by testing rather than reasoning:
	 * `alexisbcook/titanic-tutorial` is a healthy, completed run whose log nevertheless contains a
	 * full traceback — Kaggle's own interpreter teardown emitting
	 * `Error in atexit._run_exitfuncs: … AttributeError: 'NoneType' object has no attribute
	 * 'thread'` — and every event in that log, including the success marker, is on stderr. Blocking
	 * on "a traceback with no later stdout" failed that notebook. So: papermill decides first, then
	 * the marker's POSITION decides, teardown noise is discounted, and an ambiguous log warns
	 * rather than blocks.
	 *
	 * Returns [ 'done' => true|false|null (null = cannot tell), 'tracebacks' => int (author's, not
	 * Kaggle's), 'msg' => string ].
	 */
	public static function log_verdict( $log ) {
		$ev = json_decode( (string) $log, true );
		if ( ! is_array( $ev ) || ! $ev ) { return [ 'done' => null, 'tracebacks' => 0, 'msg' => '' ]; }
		$lines = [];
		$err   = [];
		foreach ( $ev as $e ) {
			if ( ! is_array( $e ) ) { continue; }
			$d = (string) ( $e['data'] ?? '' );
			$lines[] = $d;
			// Kaggle's runner writes on stderr — but so can the notebook (tqdm, warnings.warn,
			// print(file=sys.stderr)). Keeping the streams apart narrows the forgery surface; it does
			// not close it, which is why neither test below is a plain "does this string appear".
			if ( 'stderr' === (string) ( $e['stream_name'] ?? '' ) ) { $err[] = $d; }
		}
		$mark = '/\[NbConvertApp\]\s+Writing\s+\d+\s+bytes\s+to\s+__results__/';
		// THE MARKER, AND ITS POSITION. Kaggle writes the rendered result as the last thing it puts
		// on stderr, so the marker is required in the FINAL stderr event rather than anywhere in the
		// stream. A notebook can write the line — it cannot write it last.
		$done = (bool) preg_match( $mark, $err ? (string) $err[ count( $err ) - 1 ] : '' );

		// PAPERMILL IS DECISIVE, and it is read before the marker is worth anything: nbconvert runs
		// on a notebook papermill has already failed, so the marker survives a crash (see 1. above).
		// The window is everything on stderr UP TO the marker — deliberately not "up to the first
		// [NbConvertApp] line", because on the older image nbconvert IS the executor and announces
		// itself before the notebook has run at all, which would put the whole crash outside the
		// window. Imploded on newlines so the anchors below hold at every event boundary.
		$stderr = implode( "\n", $err );
		$window = $stderr;
		if ( preg_match_all( $mark, $stderr, $mm, PREG_OFFSET_CAPTURE ) ) {
			$at     = end( $mm[0] );
			$window = substr( $stderr, 0, (int) $at[1] );
		}
		// Line-anchored on purpose: these are the runner's words at the start of its own lines, and a
		// notebook whose PROSE mentions papermill must never be read as a crash. There is no forgery
		// risk in the other direction — writing these would only refuse your own work.
		$crash = '';
		if ( preg_match( '/^Exception encountered at "In \[\d+\]"/m', $window, $cm ) ) { $crash = trim( $cm[0] ); }
		elseif ( preg_match( '/^papermill\.exceptions\.PapermillExecutionError/m', $window ) ) { $crash = 'papermill.exceptions.PapermillExecutionError'; }

		// Count only tracebacks that are the AUTHOR's. Kaggle's atexit teardown emits one on
		// perfectly healthy runs; counting it would warn on almost every submission.
		$tb  = 0;
		$msg = '';
		$n   = count( $lines );
		for ( $i = 0; $i < $n; $i++ ) {
			if ( false === strpos( $lines[ $i ], 'Traceback (most recent call last)' ) ) { continue; }
			$before = $i > 0 ? $lines[ $i - 1 ] : '';
			if ( false !== strpos( $before, 'atexit._run_exitfuncs' ) ) { continue; }
			$tb++;
			// The exception line closing this traceback: the first following line that is not an
			// indented frame.
			for ( $j = $i + 1; $j < $n; $j++ ) {
				$t = rtrim( $lines[ $j ] );
				if ( '' === $t || ' ' === substr( $t, 0, 1 ) ) { continue; }
				if ( 0 === strpos( $t, '[NbConvertApp]' ) ) { break; }
				$msg = mb_substr( trim( $t ), 0, 300 );
				break;
			}
		}
		// Papermill first: its verdict outranks the marker, and its own line is the evidence a reader
		// can go and check — it names the cell that died.
		if ( '' !== $crash ) {
			return [ 'done' => false, 'tracebacks' => $tb, 'msg' => '' !== $msg ? $crash . ' — ' . $msg : $crash ];
		}
		if ( $done ) { return [ 'done' => true, 'tracebacks' => $tb, 'msg' => $msg ]; }
		// Not completed. If there is a traceback at all, that is why. If there is not, we genuinely
		// cannot tell (a script kernel, or an image that does not run NbConvert) — say so.
		return [ 'done' => $tb > 0 ? false : null, 'tracebacks' => $tb, 'msg' => $msg ];
	}

	/** Total wall-clock seconds of a run, from the last log event's timestamp. */
	public static function log_seconds( $log ) {
		$ev = json_decode( (string) $log, true );
		if ( ! is_array( $ev ) || ! $ev ) { return 0; }
		$max = 0.0;
		foreach ( $ev as $e ) { if ( is_array( $e ) ) { $max = max( $max, (float) ( $e['time'] ?? 0 ) ); } }
		return (int) round( $max );
	}

	// ── The checklist ─────────────────────────────────────────────────────────

	/** One checklist row. */
	private static function item( $id, $group, $sev, $title, $ok, $detail, $fix = '', $evidence = '' ) {
		return [
			'id'       => $id,
			'group'    => $group,
			'severity' => $sev,
			'title'    => $title,
			'state'    => $ok ? 'pass' : 'fail',
			'detail'   => $detail,
			'fix'      => $ok ? '' : $fix,
			'evidence' => $evidence,
		];
	}

	/** A check that could not be run at all (e.g. nothing selected yet). */
	private static function skip( $id, $group, $sev, $title, $detail, $evidence = '' ) {
		return [ 'id' => $id, 'group' => $group, 'severity' => $sev, 'title' => $title,
			'state' => 'skip', 'detail' => $detail, 'fix' => '', 'evidence' => $evidence ];
	}

	/**
	 * Inspect a kernel and produce the FULL checklist.
	 *
	 * $selection is the list of output filenames the author chose; pass [] to run every check that
	 * does not depend on a selection (the author sees the verdict before they pick anything, which
	 * is the point — a private dataset should be reported the moment the URL is pasted, not after
	 * they have done the work of choosing files).
	 *
	 * $user_id is the member whose submission this is — the one held to the account proof below.
	 * 0 means UNKNOWN, and unknown is neither a pass nor a failure: the ownership item is emitted as
	 * `skip` (pending), which refuses publication without accusing anybody. Two different callers
	 * need that distinction and it is the whole reason the check exists:
	 *
	 *   · `store()` always knows the member (the row's author_id), so a stored report always carries
	 *     a real pass or a real failure — never the abstention.
	 *   · A READER never reaches this function. The checklist a signed-out stranger sees on a
	 *     published work is the FROZEN report on the row (`Notebook::full`, `checks`), so this check
	 *     reports what was true at submission and is never re-evaluated against the viewer. That is
	 *     also why nothing already published can be turned into a failure by this change: no path
	 *     re-inspects a published row (`own()` refuses one, `import()` returns its stored report),
	 *     and `integrity_sweep()` reads the ledger and the signatures, never the checklist.
	 *
	 * Returns the report array stored verbatim on the work and rendered, unchanged, in public.
	 */
	public static function inspect( $owner, $slug, $selection = [], $user_id = 0 ) {
		$items = [];
		$facts = [
			'owner' => (string) $owner, 'slug' => (string) $slug,
			'url'   => Kaggle::code_url( $owner, $slug ),
		];

		// ── open ──────────────────────────────────────────────────────────────
		//
		// WHOSE NOTEBOOK IS THIS? Asked FIRST, and answered without touching Kaggle.
		//
		// Until today any member could paste any public Kaggle notebook and the platform would mint a
		// permanent CC-BY DOI crediting its Kaggle author — who never consented and might never learn
		// of it. Every other item on this list describes something the author can go and fix; this one
		// describes something a stranger cannot undo, because a citation of record is meant to outlive
		// the kernel it came from. So it BLOCKS, and it is the first line anybody reads.
		//
		// It lives in `open` because that is the group asking who this notebook belongs to and who can
		// reach it. The other three are about the run — its inputs, its files, its repeatability — and
		// none of them is about consent. The heading does not literally cover this; of the four it is
		// the only honest home for it.
		//
		// The proof itself is NOT re-run here: KaggleId owns it (a one-time string the member posts in
		// a public notebook under the handle they claim, read back with no credential — checkable by a
		// stranger, exactly like every other item on this list). This asks that register one question.
		$owner_h = strtolower( trim( (string) $owner ) );
		$uid     = (int) $user_id;
		$reg     = __NAMESPACE__ . '\\KaggleId';
		$can_ask = class_exists( $reg ) && method_exists( $reg, 'verified_handle' );
		$facts['owner_proven'] = null;
		if ( $uid <= 0 || ! $can_ask ) {
			// UNKNOWN IS NOT A PASS — and it is not a refusal either. `skip` counts as pending, so the
			// work cannot publish (report() needs blocks AND pending at zero) while the checklist says
			// plainly that nobody was accused of anything. Rendering a green tick beside "the account
			// is theirs" on a signal we never read would be the exact quiet overclaim this gate exists
			// to refuse; rendering a blue cross would accuse an author of a failure in our plumbing.
			$items[] = self::skip( 'owner_proven', 'open', self::BLOCK,
				'Whether the submitter controls the Kaggle account could not be confirmed',
				$uid > 0
					? 'The register of proven Kaggle accounts could not be read just now, so this was left unanswered rather than assumed. Nothing publishes on a check we did not run — try again in a moment.'
					: 'This checklist was run outside a member session, so there is nobody to hold the account proof against. It is left unanswered rather than treated as a pass.',
				'kernel owner=' . $owner_h . ' · submitter=' . ( $uid > 0 ? '#' . $uid : 'unknown' ) );
		} else {
			$proven = KaggleId::verified_handle( $uid, $owner_h );
			$facts['owner_proven'] = (bool) $proven;
			// THE EVIDENCE IS BUILT FROM THE VERDICT'S OWN CALL, never from the register's listing:
			// handles() returns what a member has CLAIMED, and a pending claim printed beside a tick
			// would read as a proof that does not exist. So every handle it lists is put back through
			// verified_handle(), and the line names only what actually decided this item. Bounded — a
			// member with a hundred claims does not get a hundred lookups.
			$mine = [];
			if ( method_exists( $reg, 'handles' ) ) {
				foreach ( array_slice( (array) KaggleId::handles( $uid ), 0, 12 ) as $h ) {
					$v = is_array( $h ) ? ( $h['handle'] ?? '' ) : $h;
					$v = is_scalar( $v ) ? strtolower( trim( (string) $v ) ) : '';
					if ( '' !== $v && KaggleId::verified_handle( $uid, $v ) ) { $mine[] = $v; }
				}
			}
			$mine = array_values( array_unique( $mine ) );
			$items[] = self::item( 'owner_proven', 'open', self::BLOCK,
				'The submitter has proven they control the Kaggle account',
				$proven,
				$proven
					? 'This submission names kaggle.com/' . $owner_h . ', and that account has been proven to be this member\'s own — so the person publishing this work is the person who made it.'
					: 'This submission names the Kaggle account "' . $owner_h . '", which this member has not proven they control'
						. ( $mine ? ' (they have proven: ' . implode( ', ', $mine ) . ')' : ' (they have proven no Kaggle account yet)' )
						. '. Publishing it would mint a permanent citation crediting somebody who has not asked for one.',
				'Prove the account is yours: we give you a one-time string, you put it in a public notebook under that Kaggle account, and we read it back with no credential — then run this checklist again. If the notebook is not yours, ask its author to submit it themselves. A citation in someone else\'s name is not ours to mint.',
				'kernel owner=' . $owner_h . ' · proven for this member: ' . ( $mine ? implode( ', ', $mine ) : 'none' ) );
		}

		[ $code, $meta, $src ] = Kaggle::pull( $owner, $slug );
		$private = ! empty( $meta['isPrivate'] );
		$open_ok = ( 200 === $code && ! $private );
		$items[] = self::item( 'kernel_public', 'open', self::BLOCK, 'The notebook is public on Kaggle',
			$open_ok,
			$open_ok ? 'Anyone can open it without signing in.'
				: ( 403 === $code
					? 'Kaggle refuses to serve this notebook to the public — it is private, or it has been deleted.'
					: ( $private ? 'Kaggle reports this notebook as private.' : 'Kaggle answered HTTP ' . $code . '.' ) ),
			'Open the notebook on Kaggle, then Share → set it to Public. If you have deleted it, restore it or submit a different notebook.',
			'GET /kernels/pull → HTTP ' . $code );
		if ( ! $open_ok ) { return self::report( $items, $facts ); }

		$facts['title']    = (string) ( $meta['title'] ?? '' );
		$facts['author']   = (string) ( $meta['author'] ?? '' );
		$facts['votes']    = (int) ( $meta['totalVotes'] ?? 0 );
		$facts['version']  = (int) ( $meta['currentVersionNumber'] ?? 0 );
		$facts['docker']   = (string) ( $meta['dockerImage'] ?? '' );
		$facts['machine']  = (string) ( $meta['machineShape'] ?? '' );
		$facts['language'] = (string) ( $meta['language'] ?? '' );
		$facts['internet'] = ! empty( $meta['enableInternet'] );
		$facts['gpu']      = ! empty( $meta['enableGpu'] );
		$facts['tpu']      = ! empty( $meta['enableTpu'] );
		$facts['source']   = $src;
		// Binds this report to the exact source it was produced from. The gate re-compares it before
		// letting anything publish, so a notebook edited on Kaggle after checking cannot ride an old
		// green checklist. sha1 to match Notebook::sig(), which the confirm link and the publish
		// trigger are already keyed on.
		$facts['source_sig'] = sha1( $src );

		$has_src = '' !== trim( $src );
		[ $n_code, $n_cells ] = self::code_cells( $src );
		$facts['cells'] = $n_cells;
		$facts['code_cells'] = $n_code;
		$items[] = self::item( 'source_readable', 'open', self::BLOCK, 'Its code can be read',
			$has_src,
			$has_src ? $n_code . ' code cell(s) of ' . $n_cells . ', ' . number_format_i18n( strlen( $src ) ) . ' bytes of source'
					. ' — this is the notebook as it stands NOW, which is what a reader will open and re-run.'
				: 'Kaggle returned no source for this notebook.',
			'Re-save the notebook on Kaggle so it has a committed version, then check again.',
			'blob.source ' . strlen( $src ) . ' bytes' );

		$text = self::source_text( $src );

		// ── inputs ────────────────────────────────────────────────────────────
		// Every declared input is probed individually. This is the operator's named case: a
		// notebook whose dataset is private reads perfectly for its author and is dead for
		// everyone else, and nothing in the notebook itself reveals that.
		$sources = [];
		foreach ( [ 'dataset' => 'datasetDataSources', 'model' => 'modelDataSources', 'kernel' => 'kernelDataSources' ] as $type => $key ) {
			$refs = array_values( array_filter( array_map( 'strval', (array) ( $meta[ $key ] ?? [] ) ) ) );
			$bad  = [];
			foreach ( $refs as $ref ) {
				[ $ok, $why ] = Kaggle::source_public( $type, $ref );
				$sources[] = [ 'type' => $type, 'ref' => $ref, 'public' => $ok, 'note' => $why ];
				if ( ! $ok ) { $bad[] = $ref . ' (' . $why . ')'; }
			}
			$label = [ 'dataset' => 'dataset', 'model' => 'model', 'kernel' => 'notebook' ][ $type ];
			$items[] = self::item( $type . 's_public', 'inputs', self::BLOCK,
				'Every input ' . $label . ' is public',
				! $bad,
				$refs
					? ( $bad
						? count( $bad ) . ' of ' . count( $refs ) . ' cannot be opened by the public: ' . implode( ', ', $bad )
						: 'All ' . count( $refs ) . ' public.' )
					: 'This notebook attaches no ' . $label . 's.',
				'Open each ' . $label . ' on Kaggle and set its visibility to Public. A reader who cannot open your inputs cannot re-run your notebook.',
				implode( ', ', $refs ) );
		}
		$facts['sources'] = $sources;

		$comps = array_values( array_filter( array_map( 'strval', (array) ( $meta['competitionDataSources'] ?? [] ) ) ) );
		$facts['competitions'] = $comps;
		if ( $comps ) {
			// Kaggle's competition endpoints are 401 for us, so this is DISCLOSED, never asserted —
			// competition data usually requires accepting that competition's rules first.
			$items[] = self::item( 'competitions', 'inputs', self::WARN, 'Competition data is declared',
				false,
				'Reads competition data (' . implode( ', ', $comps ) . '). A reader must join that competition and accept its rules before they can re-run this.',
				'Nothing to fix — this is disclosed to readers so they know what joining costs them.',
				implode( ', ', $comps ) );
		}

		// A notebook that needs a private credential is exactly as un-runnable as one with a
		// private dataset, so it is judged the same way.
		$secret_hits = [];
		foreach ( [ 'kaggle_secrets', 'usersecretsclient', 'get_secret(', 'set_tensorflow_credential', 'get_gcloud_credential' ] as $needle ) {
			if ( false !== strpos( $text, $needle ) ) { $secret_hits[] = $needle; }
		}
		$items[] = self::item( 'no_secrets', 'inputs', self::BLOCK, 'It needs no private credentials',
			! $secret_hits,
			$secret_hits ? 'The code reads Kaggle Secrets (' . implode( ', ', $secret_hits ) . '), which no other reader has.'
				: 'No Kaggle Secrets are read.',
			'Remove the secret, or replace what it unlocks with a public input. A reader without your credential cannot reproduce this run.',
			implode( ', ', $secret_hits ) );

		// ── run ───────────────────────────────────────────────────────────────
		[ $ocode, $files, $log, $trunc ] = Kaggle::output( $owner, $slug );
		$facts['file_count']  = count( $files );
		$facts['truncated']   = $trunc;
		$facts['run_seconds'] = self::log_seconds( $log );

		$ran = ( 200 === $ocode && '' !== trim( (string) $log ) );
		$items[] = self::item( 'has_run', 'run', self::BLOCK, 'It has actually been run',
			$ran,
			$ran ? 'Kaggle holds a run log of ' . number_format_i18n( $facts['run_seconds'] ) . ' s.'
				: 'Kaggle holds no run log for this notebook.',
			'Open the notebook on Kaggle and use Save Version → Save & Run All, then check again.',
			'GET /kernels/output → HTTP ' . $ocode );

		$v = self::log_verdict( $log );
		$facts['run_done'] = $v['done'];
		if ( $ran ) {
			// null = the log carries neither the completion marker nor a traceback. That is a real
			// state (script kernels, older images), and blocking on it would refuse work for a
			// question we cannot answer — so it warns instead, and says exactly that.
			// Three states, and the middle one is reported AS the middle one. Kaggle's completion
			// marker is decisive when present and its absence beside a traceback is decisive too,
			// but a log with neither answers nothing — and a BLOCK check that renders a green tick
			// next to "The run finished" when we do not know that is precisely the kind of quiet
			// overclaim this whole gate exists to refuse. Unknown is a warning, worded as one.
			if ( null === $v['done'] ) {
				$items[] = self::item( 'run_completed', 'run', self::WARN, 'Whether the run finished could not be confirmed',
					false,
					'Kaggle recorded no completion marker for this run, and no crash either. It may be perfectly fine — check the files below are the ones you expect.',
					'Nothing to fix if the output looks right. Re-running on Kaggle usually produces the marker.',
					'no [NbConvertApp] result marker in the log' );
			} else {
				$items[] = self::item( 'run_completed', 'run', self::BLOCK, 'The run finished',
					true === $v['done'],
					true === $v['done'] ? 'Kaggle rendered the finished notebook, so it ran to the end.'
						// NOT "so Kaggle never rendered it" — Kaggle converts a dead notebook too, and
						// saying otherwise here would be a plain untruth on the very case this check
						// was rewritten to catch. A rendered page is not a finished run.
						: 'The run ended in an unhandled exception, so it never reached the end of the notebook. Kaggle may still have rendered a page for it — a rendered page is not a finished run.',
					'Fix the error on Kaggle and Save Version → Save & Run All again. Files left behind by a crashed run are not a result.',
					$v['msg'] );
			}
			if ( true === $v['done'] && $v['tracebacks'] ) {
				$items[] = self::item( 'run_clean', 'rigour', self::WARN, 'The run log is free of errors',
					false,
					$v['tracebacks'] . ' traceback(s) were raised during the run and swallowed. Readers will see them in your log.',
					'Not blocking — but a caught exception often means a step silently did nothing.',
					$v['msg'] );
			}
		}

		$has_out = (bool) $files;
		$items[] = self::item( 'has_output', 'run', self::BLOCK, 'The run produced files',
			$has_out,
			$has_out ? number_format_i18n( count( $files ) ) . ' output file(s)' . ( $trunc ? ' (listing truncated at our cap)' : '' ) . '.'
				: 'This run wrote nothing to /kaggle/working, so there is nothing to publish.',
			'Write your result into /kaggle/working on Kaggle and Save & Run All again.',
			'kernels/output files=' . count( $files ) );
		$facts['files'] = $files;

		// ── the selection ─────────────────────────────────────────────────────
		$selection = array_values( array_unique( array_filter( array_map( 'strval', (array) $selection ) ) ) );
		$facts['selection'] = $selection;
		if ( ! $selection ) {
			$items[] = self::skip( 'selection', 'run', self::BLOCK, 'You have chosen what to publish',
				'Pick at least one file from the run output.' );
			$items[] = self::skip( 'files_fetchable', 'run', self::BLOCK, 'Every chosen file downloads', 'Waiting on your selection.' );
			$items[] = self::skip( 'type_supported', 'run', self::BLOCK, 'Every chosen file is a type we can serve', 'Waiting on your selection.' );
			$items[] = self::skip( 'size_limit', 'run', self::BLOCK, 'Every chosen file is within the size limit', 'Waiting on your selection.' );
		} else {
			$by_name = [];
			foreach ( $files as $f ) { $by_name[ $f['name'] ] = $f['url']; }
			$missing = array_values( array_diff( $selection, array_keys( $by_name ) ) );
			$items[] = self::item( 'selection', 'run', self::BLOCK, 'You have chosen what to publish',
				! $missing && count( $selection ) <= self::MAX_SELECTED,
				$missing ? count( $missing ) . ' chosen file(s) are no longer in the run output: ' . implode( ', ', array_slice( $missing, 0, 5 ) )
					: ( count( $selection ) > self::MAX_SELECTED
						? 'You picked ' . count( $selection ) . ' files; the limit is ' . self::MAX_SELECTED . '.'
						: count( $selection ) . ' file(s) chosen.' ),
				$missing ? 'Re-open the file picker and choose from the current run output.' : 'Choose at most ' . self::MAX_SELECTED . ' files.',
				implode( ', ', array_slice( $selection, 0, 8 ) ) );

			$bad_type = [];
			foreach ( $selection as $name ) { if ( '' === self::class_of( $name ) ) { $bad_type[] = $name; } }
			$items[] = self::item( 'type_supported', 'run', self::BLOCK, 'Every chosen file is a type we can serve',
				! $bad_type,
				$bad_type ? 'Not serveable: ' . implode( ', ', array_slice( $bad_type, 0, 6 ) )
					: 'All ' . count( $selection ) . ' chosen file(s) are serveable.',
				'Deselect those files, or write your result in one of the supported formats.',
				implode( ', ', array_slice( $bad_type, 0, 8 ) ) );

			// Sizes come from a one-byte ranged GET per file: HEAD is 404 on kaggleusercontent, and
			// downloading 24 files to learn their size would be absurd. This doubles as the
			// "does it actually download" probe, so the two checks share one network pass.
			$sizes = [];
			$dead  = [];
			$total = 0;
			$over  = [];
			foreach ( $selection as $name ) {
				if ( ! isset( $by_name[ $name ] ) ) { $dead[] = $name; continue; }
				$n = Kaggle::size_of( $by_name[ $name ] );
				if ( $n < 0 ) { $dead[] = $name; continue; }
				$sizes[ $name ] = $n;
				$total += $n;
				if ( $n > self::MAX_FILE_BYTES ) { $over[] = $name; }
			}
			$facts['sizes'] = $sizes;
			$facts['bytes'] = $total;
			$items[] = self::item( 'files_fetchable', 'run', self::BLOCK, 'Every chosen file downloads',
				! $dead,
				$dead ? count( $dead ) . ' chosen file(s) could not be fetched from Kaggle: ' . implode( ', ', array_slice( $dead, 0, 5 ) )
					: 'All ' . count( $sizes ) . ' fetched, ' . size_format( $total ) . ' in total.',
				'Re-run the notebook on Kaggle so the output is regenerated, then check again.',
				implode( ', ', array_slice( $dead, 0, 8 ) ) );
			$items[] = self::item( 'size_limit', 'run', self::BLOCK, 'Every chosen file is within the size limit',
				! $over && $total <= self::MAX_TOTAL_BYTES,
				$over ? 'Over ' . size_format( self::MAX_FILE_BYTES ) . ': ' . implode( ', ', $over )
					: ( $total > self::MAX_TOTAL_BYTES
						? 'The selection totals ' . size_format( $total ) . '; the limit is ' . size_format( self::MAX_TOTAL_BYTES ) . '.'
						: size_format( $total ) . ' total.' ),
				'Publish fewer or smaller files. Everything you publish is mirrored to our CDN so it outlives the Kaggle copy.',
				size_format( $total ) );

			// ── the ONE type whose BYTES are checked, not just its name ──────
			//
			// Every other artifact this platform publishes is inert data a browser decodes. An SVG is
			// a DOCUMENT: opened at its own URL rather than inside an <img>, it runs whatever it
			// contains with the serving origin's authority — and these bytes are attacker-influenced,
			// because any member may submit any public Kaggle notebook and its author wrote every byte
			// of its output. So the extension is not enough here, and Svg::clean() is run against the
			// real file, now, while refusing still costs the author nothing but an edit.
			//
			// This is a BLOCK, and the wording is exact: we are not "scanning for something bad", we
			// are refusing to publish anything we cannot rebuild from an allow-list. The same call
			// runs again in mirror(), against the bytes actually being stored — this one exists so the
			// author reads the reason on the checklist instead of hitting it at publication.
			$svg_names = [];
			foreach ( $selection as $name ) { if ( 'svg' === self::ext( $name ) ) { $svg_names[] = $name; } }
			if ( $svg_names ) {
				$svg_bad    = [];
				$svg_unread = [];
				$svg_ok     = 0;
				foreach ( $svg_names as $name ) {
					// A file we could not list or size is already reported by files_fetchable — saying
					// it twice, in different words, would read as two separate problems.
					if ( ! isset( $by_name[ $name ] ) ) { continue; }
					if ( isset( $sizes[ $name ] ) && $sizes[ $name ] > Svg::MAX_BYTES ) {
						$svg_bad[] = $name . ' — it is ' . size_format( $sizes[ $name ] ) . ', and the limit for a drawing is ' . size_format( Svg::MAX_BYTES );
						continue;
					}
					// A file whose size we could not establish is NOT safe to range-read here: the
					// 0-2MB read can come back truncated, Svg::clean would refuse the fragment as
					// malformed, and we would accuse a perfectly good drawing.
					if ( ! isset( $sizes[ $name ] ) || $sizes[ $name ] < 0 ) {
						$svg_unread[] = $name . ' — its size could not be established, so it was not read';
						continue;
					}
					$raw = Kaggle::fetch_bytes( $by_name[ $name ], Svg::MAX_BYTES );
					// NEVER render "we could not look" as a pass. A fetch that fails — timeout, an
					// expired signed URL, a Kaggle 5xx — leaves this check with no evidence at all,
					// and a green tick on no evidence is the exact failure this checklist exists to
					// prevent. It is not a refusal either: the author has done nothing wrong. It is
					// pending, and pending does not publish.
					if ( '' === $raw ) {
						$svg_unread[] = $name . ' — it could not be downloaded from Kaggle just now';
						continue;
					}
					$c = Svg::clean( $raw );
					if ( ! empty( $c['ok'] ) ) { $svg_ok++; } else { $svg_bad[] = $name . ' — ' . $c['why']; }
				}
				$items[] = self::item( 'svg_safe', 'run', self::BLOCK, 'Every chosen drawing is self-contained and carries no code',
					! $svg_bad && ! $svg_unread && $svg_ok === count( $svg_names ),
					$svg_bad
						? implode( ' · ', array_slice( $svg_bad, 0, 4 ) )
						: ( $svg_unread
							? 'Not checked yet: ' . implode( ' · ', array_slice( $svg_unread, 0, 4 ) ) . '. Re-check in a moment.'
							: $svg_ok . ' drawing(s) rebuilt from an allow-list of shapes, gradients, styles and animation — no script, no embedded document, and not one reference to another host.' ),
					'An SVG is the only thing you can publish here that a browser EXECUTES, so we publish our own rebuild of it rather than the file as it arrived. Remove whatever is named above and re-run the notebook. If your drawing needs a font or an image from the web, inline it — anything fetched from another host would be a request made by every reader who scrolls past your work.',
					implode( ' · ', array_slice( $svg_bad, 0, 4 ) ) );
			}
		}

		// ── rigour (all warnings) ─────────────────────────────────────────────
		$items[] = self::item( 'internet_off', 'rigour', self::WARN, 'It ran with the internet switched off',
			! $facts['internet'],
			$facts['internet']
				? 'Internet was ON, so this run reached the network. Whatever it downloaded can change or disappear, and a reader may get a different result.'
				: "Internet was OFF — on Kaggle's own record. Everything this run used came from its declared inputs.",
			'Turn Internet off in the notebook settings and re-run, if the work does not genuinely need the network.',
			'enableInternet=' . ( $facts['internet'] ? 'true' : 'false' ) );

		$rng = [];
		foreach ( [ 'numpy' => 'np.random.seed', 'random' => 'random.seed', 'torch' => 'torch.manual_seed', 'tensorflow' => 'tf.random.set_seed' ] as $lib => $call ) {
			$uses = ( false !== strpos( $text, $lib . '.' ) || false !== strpos( $text, 'import ' . $lib ) );
			if ( $uses && false === strpos( $text, strtolower( $call ) ) ) { $rng[] = $lib; }
		}
		$items[] = self::item( 'seeded', 'rigour', self::WARN, 'Randomness is seeded',
			! $rng,
			$rng ? 'Uses ' . implode( ', ', $rng ) . ' without a visible seed, so a re-run may not match.'
				: 'No unseeded random source found.',
			'Seed every library you draw randomness from, at the top of the notebook.',
			implode( ', ', $rng ) );

		// Only genuine package tokens count. An install line is a SHELL line, so it is riddled with
		// things that are not packages — redirections, pipes, `tail -5`, a `-r requirements.txt`
		// path, `&&` chains. Reporting those as "unpinned dependencies" would be noise that trains
		// authors to ignore the warning, which is worse than not warning at all.
		$unpinned = [];
		if ( preg_match_all( '/(?:pip|pip3|uv pip)\s+install\s+([^\n\r]+)/', $text, $m ) ) {
			foreach ( $m[1] as $line ) {
				// Everything from the first shell operator onward belongs to another command.
				$line = preg_split( '/\s(?:\||&&|;|\d?>|>>)/', $line )[0];
				foreach ( preg_split( '/\s+/', trim( $line ) ) as $tokn ) {
					$tokn = trim( $tokn, "'\" \t" );
					if ( '' === $tokn ) { continue; }
					if ( '-' === $tokn[0] ) { continue; }                      // a flag (and -r/-e take the next token)
					if ( strpbrk( $tokn, '/\\{}$*<>|&;`' ) !== false ) { continue; }  // a path, a variable, a glob
					if ( false !== strpos( $tokn, '==' ) ) { continue; }        // pinned — the good case
					// A requirement specifier that is merely loose (>=, ~=, <) is still unpinned, and
					// so is a bare name. Both are reported under the name alone.
					$name = preg_split( '/[<>=~!\[]/', $tokn )[0];
					if ( preg_match( '/^[a-z0-9][a-z0-9._-]{0,63}$/i', $name ) ) { $unpinned[] = $name; }
				}
			}
		}
		$unpinned = array_values( array_slice( array_unique( array_filter( $unpinned ) ), 0, 8 ) );
		$items[] = self::item( 'pinned_installs', 'rigour', self::WARN, 'In-notebook installs are pinned',
			! $unpinned,
			$unpinned ? 'Installs without a pinned version: ' . implode( ', ', $unpinned ) . '. A different version next month is a different experiment.'
				: 'No unpinned installs found.',
			'Pin every install as name==version.',
			implode( ', ', $unpinned ) );

		$clock = [];
		foreach ( [ 'datetime.now(', 'date.today(', 'time.time(', 'datetime.utcnow(' ] as $needle ) {
			if ( false !== strpos( $text, $needle ) ) { $clock[] = rtrim( $needle, '(' ); }
		}
		$items[] = self::item( 'no_wall_clock', 'rigour', self::WARN, 'The result does not depend on the clock',
			! $clock,
			$clock ? 'Reads the wall clock (' . implode( ', ', $clock ) . '). If that reaches your output, no re-run can match it.'
				: 'No wall-clock reads found.',
			'Keep the clock out of anything you write to /kaggle/working.',
			implode( ', ', $clock ) );

		$acc = $facts['tpu'] ? 'TPU' : ( $facts['gpu'] ? 'GPU' : '' );
		$items[] = self::item( 'accelerator', 'rigour', self::WARN, 'It runs on ordinary hardware',
			'' === $acc,
			'' === $acc ? 'CPU only — anyone can re-run it.'
				: 'Needs a ' . $acc . ' (' . ( $facts['machine'] ?: $acc ) . '). A reader needs the same accelerator and enough Kaggle quota.',
			'Nothing to fix if the work needs it — this is disclosed so readers know what re-running costs.',
			'machineShape=' . $facts['machine'] );

		$pinned_env = false !== strpos( $facts['docker'], '@sha256:' );
		$items[] = self::item( 'env_pinned', 'rigour', self::WARN, 'The environment image is pinned',
			$pinned_env,
			$pinned_env ? 'Kaggle recorded the exact software environment this run used.' : 'Kaggle recorded no exact version of the software environment for this run.',
			'Nothing to fix on your side — Kaggle pins this.',
			$facts['docker'] );

		if ( $selection && $files ) {
			$ratio    = count( $selection ) / max( 1, count( $files ) );
			$focused  = count( $files ) <= 50 || $ratio >= 0.02;
			$items[] = self::item( 'output_focused', 'rigour', self::WARN, 'The output is the work, not everything the notebook downloaded',
				$focused,
				$focused ? 'The run output is focused on its result.'
					: 'The run wrote ' . number_format_i18n( count( $files ) ) . ' files — usually a cloned repository or a cache landing in /kaggle/working alongside the real result.',
				'Not blocking. Consider writing your result into a clean subfolder so readers can find it.',
				count( $selection ) . ' of ' . count( $files ) );
		}

		return self::report( $items, $facts );
	}

	/**
	 * Roll a set of items up into the stored report.
	 *
	 * `blocks` counts only things that are WRONG. A check still waiting on the author (they have
	 * not picked their files yet) is `pending`, not a failure — conflating the two greets a member
	 * who has just pasted a perfectly good URL with "5 problems", which is both false and
	 * discouraging. Publication needs blocks AND pending to be zero; the two are worded differently
	 * everywhere they surface.
	 */
	private static function report( $items, $facts ) {
		$blocks  = 0;
		$warns   = 0;
		$pending = 0;
		foreach ( $items as $i ) {
			if ( 'pass' === $i['state'] ) { continue; }
			if ( 'skip' === $i['state'] ) { $pending++; continue; }
			if ( self::BLOCK === $i['severity'] ) { $blocks++; } else { $warns++; }
		}
		return [
			'ok'        => 0 === $blocks && 0 === $pending,
			'blocks'    => $blocks,
			'pending'   => $pending,
			'warnings'  => $warns,
			'items'     => $items,
			'facts'     => $facts,
			'groups'    => self::GROUPS,
			'checked_at'=> Data::now(),
		];
	}

	// ── The submission flow ───────────────────────────────────────────────────
	//
	//   POST studio/kernels            {url}            → a draft, with the checklist already run
	//   GET  studio/notebooks/{id}/outputs ?q= ?cursor= → the run's output files, to choose from
	//   POST studio/notebooks/{id}/select  {files[]}    → choose, re-check
	//   POST studio/notebooks/{id}/check               → re-run the checklist (after fixing Kaggle)
	//
	// Publication itself is unchanged and stays in Notebook.php: it is REQUESTED here and minted
	// only by the author's own emailed secret plus their device signature.

	/**
	 * Load a work the caller may edit, or an error response.
	 *
	 * A PUBLISHED row is immutable here. Every mutating path in this class rewrites `ipynb` with a
	 * fresh pull from Kaggle, and `sig(ipynb)` is what the author's confirmation ledger row, the
	 * database publish-guard and `integrity_sweep()` are all keyed on — so re-checking a published
	 * work would move the signature out from under its own proof and the sweep would demote a
	 * perfectly good publication on its next pass. Published means finished.
	 */
	private static function own( $req, $allow_published = false ) {
		$id = Rest::pint( $req, 'id' );
		$r  = Data::one( 'SELECT * FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $r || (int) $r['author_id'] !== Rest::uid() ) { return [ null, Rest::err( 'not_found', 'No such work', 404 ) ]; }
		if ( 'removed' === (string) $r['status'] ) { return [ null, Rest::err( 'gone', 'Removed', 410 ) ]; }
		if ( ! $allow_published && 'published' === (string) $r['status'] ) {
			return [ null, Rest::err( 'published', 'This work is published — its notebook and files are fixed', 409 ) ];
		}
		return [ $r, null ];
	}

	/**
	 * Any change to WHAT WILL BE PUBLISHED withdraws an outstanding publication request.
	 *
	 * The emailed secret is hashed against `sha1(ipynb)` and the passkey challenge signs the same
	 * value, so both bind the NOTEBOOK — and nothing bound the file selection, which is the thing
	 * actually mirrored, DOI'd and put in the Library. Without this, a token-holding agent could
	 * wait for the member to request publication, swap the selection, and have the member sign a
	 * set of files they never chose. Voiding the request is the same rule `save()` already applies
	 * to a title change, applied to the far more consequential edit.
	 */
	private static function void_pending( $r ) {
		if ( 'pending' !== (string) $r['status'] ) { return false; }
		// Release the once-an-hour mail throttle too. It exists to stop a flood of confirm emails,
		// NOT to punish an edit the platform itself just invalidated — without this, changing one
		// checkbox kills the live link and then refuses to send its replacement, locking the author
		// out of their own submission for the rest of the hour with a dead link in their inbox.
		delete_transient( 'aq_nb_aucnf_' . (int) $r['id'] );
		return (bool) Data::update( 'aq_notebooks',
			[ 'status' => 'draft', 'author_token' => '', 'author_nonce' => '',
				'decision_note' => 'the published files changed, so the confirmation link was voided',
				'updated' => Data::now() ],
			[ 'id' => (int) $r['id'], 'status' => 'pending' ] );
	}

	/**
	 * Persist a fresh checklist onto a work and return the stored report.
	 *
	 * The row's `author_id` — the MEMBER who submitted this, never the Kaggle author — is what the
	 * account-proof check is held against, and it is passed from here rather than read from the
	 * session so that a re-check, a cron pass and an API-token call all judge the same person: the
	 * one whose submission it is. The report this writes is the one a signed-out reader is served
	 * for good, so the answer is frozen here, at submission, with the member in hand.
	 */
	public static function store( $r, $selection = null ) {
		$sel  = null === $selection ? (array) ( Data::dec( $r['selection'] ?? '' ) ?: [] ) : $selection;
		$rep  = self::inspect( (string) $r['kg_owner'], (string) $r['kg_slug'], $sel, (int) ( $r['author_id'] ?? 0 ) );
		$f    = $rep['facts'];
		$save = [
			'checks'     => Data::enc( $rep ),
			'checked_at' => Data::now(),
			'selection'  => Data::enc( array_values( $sel ) ),
			'updated'    => Data::now(),
		];
		// The Kaggle source IS the work's source of record, so it lands in `ipynb` — which keeps
		// sig() (sha1 over ipynb) meaningful and leaves the publish-guard trigger, the confirm-token
		// binding and the integrity sweep working exactly as they did, with no digest migration.
		// An edit on Kaggle therefore voids an outstanding confirm link, which is correct.
		if ( isset( $f['source'] ) && '' !== $f['source'] ) {
			$save['ipynb']      = (string) $f['source'];
			$save['size_bytes'] = strlen( (string) $f['source'] );
		}
		if ( ! empty( $f['title'] ) && '' === trim( (string) $r['title'] ) ) { $save['title'] = mb_substr( (string) $f['title'], 0, 200 ); }
		// The facts are stored WITHOUT the two heavy fields: the source is already in `ipynb`, and
		// the file listing is re-fetched on demand (its URLs are signed and expire in minutes, so a
		// stored copy would be worse than useless — it would be misleading).
		unset( $f['source'], $f['files'] );
		$save['kg_facts'] = Data::enc( $f );
		Data::update( 'aq_notebooks', $save, [ 'id' => (int) $r['id'] ] );
		// Mirror the source to its gist — GitHub is the source-code CDN, and a gist is the only
		// address Colab will open (operator 2026-07-29). At SUBMISSION, not at publication: the
		// three tiers are a development ladder, so a Colab link that appears only after publishing
		// arrives a step too late to be used. Best-effort and idempotent; it compares the bytes it
		// is about to send with the row's previous source, so an unchanged re-check costs nothing.
		if ( isset( $save['ipynb'] ) ) {
			// Hand it the row AS UPDATED. $r is the pre-update copy, and on a first import the title is
			// still empty at this point (it is set two lines above, in $save) — so every freshly imported
			// work minted a gist described as `ArtaQuest — "" (work #N)` in a file called
			// notebook-nbN.ipynb, and the filename is baked into the Colab URL for good.
			$fresh = array_merge( $r, $save );
			Gist::sync_row( $fresh, (string) $save['ipynb'] );
		}
		return $rep;
	}

	/**
	 * POST studio/kernels {url} — the whole submission, step one.
	 *
	 * Idempotent per member per kernel: pasting the same URL twice returns the SAME draft rather
	 * than a second one. A member who re-runs their notebook on Kaggle and pastes the link again is
	 * updating their submission, not starting a rival copy of it.
	 */
	public static function import( $req ) {
		Notebook::ensure_tables();
		if ( Rest::throttle( 'aq_kg_import', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid = Rest::uid();
		$url = (string) Rest::p( $req, 'url', '' );
		$k   = Kaggle::parse_url( $url );
		if ( ! $k ) {
			return Rest::err( 'bad_url',
				'That is not a Kaggle notebook link. Open your notebook on Kaggle and copy the address bar — it looks like https://www.kaggle.com/code/<your-name>/<your-notebook>/output', 422 );
		}
		$existing = Data::one( 'SELECT * FROM ' . Data::t( 'aq_notebooks' )
			. " WHERE author_id = %d AND kg_owner = %s AND kg_slug = %s AND status <> 'removed' ORDER BY id DESC LIMIT 1",
			[ $uid, $k['owner'], $k['slug'] ] );
		if ( $existing ) {
			// Re-pasting the URL of a work that is already PUBLISHED must not re-pull and rewrite its
			// `ipynb`: that is the value the author's confirmation ledger row is signed against, so
			// moving it would make integrity_sweep() demote a good publication on its next pass.
			if ( 'published' === (string) $existing['status'] ) {
				return [ 'id' => (int) $existing['id'], 'existing' => true, 'published' => true,
					'checks' => Data::dec( $existing['checks'] ?? '' ) ?: null ];
			}
			$rep = self::store( $existing );
			return [ 'id' => (int) $existing['id'], 'existing' => true, 'published' => false, 'checks' => $rep ];
		}
		$now = Data::now();
		$id  = Data::insert( 'aq_notebooks', [
			'author_id' => $uid,
			'kind'      => '',
			'slug'      => 'nb-pending-' . $uid . '-' . $now . wp_rand( 100, 999 ),
			'title'     => '',
			'kg_owner'  => $k['owner'],
			'kg_slug'   => $k['slug'],
			'kg_url'    => Kaggle::code_url( $k['owner'], $k['slug'] ),
			'status'    => 'draft',
			'created'   => $now,
			'updated'   => $now,
		] );
		if ( ! $id ) { return Rest::err( 'server_error', 'Could not start the submission', 500 ); }
		$r   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE id = %d', [ $id ] );
		$rep = self::store( $r, [] );
		$r   = Data::one( 'SELECT * FROM ' . Data::t( 'aq_notebooks' ) . ' WHERE id = %d', [ $id ] );
		$slug = sanitize_title( (string) $r['title'] ?: $k['slug'] );
		Data::update( 'aq_notebooks', [ 'slug' => ( $slug ?: 'untitled' ) . '-' . $id ], [ 'id' => $id ] );
		return [ 'id' => (int) $id, 'existing' => false, 'published' => false, 'checks' => $rep ];
	}

	/** POST studio/notebooks/{id}/check — re-read everything from Kaggle and re-run the checklist. */
	public static function recheck( $req ) {
		Notebook::ensure_tables();
		if ( Rest::throttle( 'aq_kg_check', 40, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		[ $r, $err ] = self::own( $req );
		if ( $err ) { return $err; }
		if ( '' === (string) $r['kg_slug'] ) { return Rest::err( 'no_kernel', 'This work has no Kaggle notebook attached', 409 ); }
		return [ 'ok' => true, 'checks' => self::store( $r ) ];
	}

	/**
	 * GET studio/notebooks/{id}/outputs — the file picker's source.
	 *
	 * Deliberately live rather than cached: the signed URLs Kaggle mints expire within minutes, and
	 * the author is often here BECAUSE they just re-ran the notebook. `?q=` filters by path and
	 * `?serveable=1` hides everything the Library could not publish anyway — with 1,322-file
	 * checkouts in the wild, an unfiltered list is not a picker, it is a haystack.
	 */
	public static function outputs( $req ) {
		Notebook::ensure_tables();
		// Every call is a live paged read of Kaggle's API on our credential — the same outbound cost
		// as recheck (40/600) and import (20/3600), which are both throttled. This one was not, so the
		// cheapest way to burn our Kaggle rate limit for everybody was to poll the file picker.
		if ( Rest::throttle( 'aq_kernel_outputs', 60, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		[ $r, $err ] = self::own( $req );
		if ( $err ) { return $err; }
		[ $code, $files ] = Kaggle::output( (string) $r['kg_owner'], (string) $r['kg_slug'] );
		if ( 200 !== $code ) { return Rest::err( 'kaggle', 'Kaggle would not list this run output (HTTP ' . $code . ')', 502 ); }
		$q         = strtolower( trim( (string) Rest::p( $req, 'q', '' ) ) );
		$serveable = (bool) Rest::pint( $req, 'serveable', 0 );
		$out       = [];
		$counts    = [];
		foreach ( $files as $f ) {
			$cls = self::class_of( $f['name'] );
			$counts[ $cls ?: 'other' ] = ( $counts[ $cls ?: 'other' ] ?? 0 ) + 1;
			if ( $serveable && '' === $cls ) { continue; }
			if ( '' !== $q && false === strpos( strtolower( $f['name'] ), $q ) ) { continue; }
			$out[] = [ 'name' => $f['name'], 'class' => $cls, 'ext' => self::ext( $f['name'] ) ];
		}
		// Serveable media first, then alphabetically — the file someone came to publish should not
		// be on page seven behind a vendored dependency tree.
		usort( $out, function ( $a, $b ) {
			$ra = '' === $a['class'] ? 99 : array_search( $a['class'], self::HERO_ORDER, true );
			$rb = '' === $b['class'] ? 99 : array_search( $b['class'], self::HERO_ORDER, true );
			return $ra === $rb ? strcmp( $a['name'], $b['name'] ) : $ra - $rb;
		} );
		$total = count( $out );
		$page  = array_slice( $out, max( 0, Rest::pint( $req, 'cursor', 0 ) ), 200 );
		return [
			'items'     => $page,
			'total'     => $total,
			'all'       => count( $files ),
			'counts'    => $counts,
			'selection' => (array) ( Data::dec( $r['selection'] ?? '' ) ?: [] ),
			'next'      => Rest::pint( $req, 'cursor', 0 ) + 200 < $total ? Rest::pint( $req, 'cursor', 0 ) + 200 : null,
		];
	}

	/** POST studio/notebooks/{id}/select {files:[]} — choose what to publish, then re-check. */
	public static function select( $req ) {
		Notebook::ensure_tables();
		// Choosing files re-runs the whole checklist, which re-reads Kaggle — the same outbound cost as
		// recheck, and token-reachable (Api::TOKEN_ROUTES), so a script can drive it in a loop.
		if ( Rest::throttle( 'aq_kernel_select', 40, 600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		[ $r, $err ] = self::own( $req );
		if ( $err ) { return $err; }
		$files = Rest::p( $req, 'files', [] );
		if ( ! is_array( $files ) ) { return Rest::err( 'bad_files', 'files must be a list of output filenames', 422 ); }
		$files = array_values( array_unique( array_filter( array_map( 'strval', $files ) ) ) );
		if ( count( $files ) > self::MAX_SELECTED ) {
			return Rest::err( 'too_many', 'Choose at most ' . self::MAX_SELECTED . ' files', 422 );
		}
		$was     = (array) ( Data::dec( $r['selection'] ?? '' ) ?: [] );
		$changed = count( $was ) !== count( $files ) || (bool) array_diff( $files, $was );
		$voided  = $changed ? self::void_pending( $r ) : false;
		$rep     = self::store( $r, $files );
		// The kind is DERIVED from what was chosen rather than declared up front — the work is
		// whatever its published artifact actually is. Derivation reads media classes, though, and
		// some kinds are simply not inferable from a file extension: a survey and a 2D game both
		// ship JSON or HTML like anything else. So the derived value is a DEFAULT the author may
		// correct, never a verdict — without the override three of the eleven kinds (survey, 2D
		// game, 3D game) could never be reached at all.
		$want = sanitize_key( (string) Rest::p( $req, 'kind', '' ) );
		$kind = ( $want && isset( Notebook::KINDS[ $want ] ) ) ? $want : self::kind_for( $files );
		if ( $kind && $kind !== (string) $r['kind'] ) { Data::update( 'aq_notebooks', [ 'kind' => $kind ], [ 'id' => (int) $r['id'] ] ); }
		return [ 'ok' => true, 'kind' => $kind, 'voided' => $voided, 'checks' => $rep ];
	}

	/** The 11-kind roster, inferred from the chosen files' media classes. */
	public static function kind_for( $files ) {
		$seen = [];
		foreach ( (array) $files as $f ) { $c = self::class_of( $f ); if ( $c ) { $seen[ $c ] = true; } }
		if ( isset( $seen['audio'] ) ) { return 'music'; }
		// A vector scene is read as an ANIMATION, because that is what the format was adopted for
		// (2026-07-30) — and like every other line here it is only a DEFAULT the author may correct
		// in the same request. A static diagram published as .svg lands on animation2d and its author
		// sets it back to illustration2d; that is the documented shape of this whole function.
		if ( isset( $seen['scene'] ) ) { return isset( $seen['model3d'] ) ? 'animation3d' : 'animation2d'; }
		if ( isset( $seen['video'] ) ) { return isset( $seen['model3d'] ) ? 'animation3d' : 'animation2d'; }
		if ( isset( $seen['model3d'] ) ) { return 'illustration3d'; }
		if ( isset( $seen['image'] ) ) { return 'illustration2d'; }
		if ( isset( $seen['weights'] ) ) { return 'model'; }
		if ( isset( $seen['data'] ) ) { return 'dataset'; }
		if ( isset( $seen['doc'] ) || isset( $seen['notebook'] ) ) { return 'article'; }
		return '';
	}

	// ── Publishing: mirror the chosen files into the Library ──────────────────

	/**
	 * Copy every selected output file out of Kaggle and into the Library, at publish time.
	 *
	 * This is the step that makes a published work durable. A Kaggle kernel is owner-editable and
	 * owner-deletable, and its output URLs are signed and expire in minutes — so a citation that
	 * merely POINTS at Kaggle resolves only for as long as its author leaves it alone, which is not
	 * a citation at all. We take our own copy, serve it from our own CDN, and keep the kernel link
	 * beside it as provenance.
	 *
	 * Idempotent: re-publishing the same work updates rows rather than duplicating them, keyed on
	 * (nb_id, sha1(name)). Returns [ stored_count, error_string ].
	 */
	public static function mirror( $r, $force = false ) {
		Notebook::ensure_tables();
		$sel = (array) ( Data::dec( $r['selection'] ?? '' ) ?: [] );
		// PRUNE FIRST, always. Dropping a file from the selection must un-list it, and emptying the
		// selection entirely is the case that matters most — it used to return here, before the
		// cleanup ran, so every previously published file stayed live in the Library.
		self::prune( $r, $sel );
		if ( ! $sel ) { return [ 0, 'nothing selected' ]; }
		// Already mirrored? Re-downloading megabytes to arrive at identical content-addressed keys
		// helps nobody. The gate has already re-verified that the kernel source is unchanged, and
		// the selection is part of the same row, so existing rows for every selected file mean the
		// bytes are the ones the author reviewed. `$force` re-fetches regardless.
		if ( ! $force ) {
			$have = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_library' )
				. ' WHERE nb_id = %d AND name_key IN (' . implode( ',', array_fill( 0, count( $sel ), '%s' ) ) . ')',
				array_merge( [ (int) $r['id'] ], array_map( 'sha1', $sel ) ) );
			if ( $have === count( $sel ) ) { return [ $have, '' ]; }
		}
		[ $code, $files ] = Kaggle::output( (string) $r['kg_owner'], (string) $r['kg_slug'] );
		if ( 200 !== $code ) { return [ 0, 'Kaggle would not list the run output (HTTP ' . $code . ')' ]; }
		$by = [];
		foreach ( $files as $f ) { $by[ $f['name'] ] = $f['url']; }
		$n     = 0;
		$total = 0;
		foreach ( $sel as $name ) {
			if ( ! isset( $by[ $name ] ) ) { return [ $n, 'the file "' . $name . '" is no longer in the run output' ]; }
			$cls = self::class_of( $name );
			if ( '' === $cls ) { return [ $n, 'the file "' . $name . '" is not a type we can serve' ]; }
			// AN SVG IS THE ONE CLASS WE HOLD IN MEMORY, because it is the one class whose BYTES are
			// the deliverable: Svg::clean rebuilds the document and we store the rebuild. It has its
			// own, far smaller ceiling — and every check below compares against the cap ACTUALLY
			// APPLIED, which is what keeps "your drawing is too big" from being reported as "the
			// download was incomplete".
			$is_svg = ( 'svg' === self::ext( $name ) );
			$cap    = $is_svg ? Svg::MAX_BYTES : self::MAX_FILE_BYTES;
			// SIZE FIRST. Both fetches ask for `Range: bytes=0-<cap>`, so a file over the cap comes
			// back TRUNCATED with a perfectly successful 206 — and storing that would publish a
			// half-written artifact, content-addressed and hashed, as though it were the whole thing.
			$size = Kaggle::size_of( $by[ $name ] );
			if ( $size > $cap ) {
				return [ $n, 'the file "' . $name . '" is ' . size_format( $size ) . ', over the ' . size_format( $cap ) . ' limit' ];
			}
			// Everything but an SVG STREAMS to disk. Reading a 512 MB artifact into a PHP string was
			// how the advertised ceiling stayed un-deliverable: the request ran out of memory (or ran
			// out the gateway's clock) before a byte reached the Library.
			$tmp   = '';
			$bytes = '';
			if ( $is_svg ) {
				$bytes = Kaggle::fetch_bytes( $by[ $name ], $cap );
				$len   = strlen( $bytes );
			} else {
				$tmp = Kaggle::fetch_to_file( $by[ $name ], $cap );
				$len = '' === $tmp ? 0 : (int) filesize( $tmp );
			}
			// A zero-length result is a failed download, not an empty artifact: an output file with
			// nothing in it is not a result either, and refusing both is what the string version did.
			if ( $len <= 0 ) {
				if ( '' !== $tmp ) { @unlink( $tmp ); }
				return [ $n, 'could not download "' . $name . '" from Kaggle' ];
			}
			// With no size to compare against we cannot prove completeness — and a body that comes
			// back exactly at the ceiling is far more likely a truncated ranged read than a file
			// that happens to be 512 MB to the byte. Refuse rather than store a half-file as whole.
			if ( $size < 0 && $len >= $cap ) {
				if ( '' !== $tmp ) { @unlink( $tmp ); }
				return [ $n, 'could not confirm the size of "' . $name . '", and it came back at the limit — try again' ];
			}
			if ( $size >= 0 && $len !== $size ) {
				if ( '' !== $tmp ) { @unlink( $tmp ); }
				return [ $n, 'the download of "' . $name . '" was incomplete (' . size_format( $len ) . ' of ' . size_format( $size ) . ') — try again' ];
			}
			// THE RUNNING TOTAL, and it is enforced HERE rather than only against the checklist's
			// snapshot. `size_limit` summed the sizes read when the author last checked; a re-run on
			// Kaggle between that moment and publication can grow every file, and MAX_TOTAL_BYTES is
			// a promise about what we STORE, not about what we once measured.
			$total += $len;
			if ( $total > self::MAX_TOTAL_BYTES ) {
				if ( '' !== $tmp ) { @unlink( $tmp ); }
				return [ $n, 'this selection now totals ' . size_format( $total ) . ' on Kaggle, over the ' . size_format( self::MAX_TOTAL_BYTES ) . ' limit — publish fewer or smaller files' ];
			}
			// AN SVG IS REBUILT, NOT MERELY INSPECTED — and this happens BEFORE the digest, so the
			// sha256 in aq_library is the digest of the bytes we actually serve. That matters twice
			// over: Media::backfill_origin() re-verifies the stored digest against the object it
			// pulls back from R2, and Media will only put an SVG in the web root when the bytes it
			// is handed are byte-identical to Svg::clean()'s own output.
			//
			// Validating the author's file and then serving the author's file would be the classic
			// version of this mistake: our parser and the browser's would only have to disagree once.
			// There is nothing left of the original document for a second parser to read differently,
			// because the original document is discarded here.
			//
			// The checklist already ran this exact call (svg_safe), so a refusal at this point means
			// the file changed on Kaggle since it was checked. Refusing is right either way: this is
			// the last moment before bytes become durable, public and DOI'd.
			if ( $is_svg ) {
				$c = Svg::clean( $bytes );
				if ( empty( $c['ok'] ) ) {
					return [ $n, 'the drawing "' . $name . '" cannot be published — ' . $c['why'] ];
				}
				$bytes = (string) $c['svg'];
				$len   = strlen( $bytes );
			}
			// Hashed from the FILE for a streamed download — hash_file reads it in chunks, so the one
			// artifact we were careful not to buffer is not buffered here either.
			$sha = $is_svg ? hash( 'sha256', $bytes ) : (string) hash_file( 'sha256', $tmp );
			if ( '' === $sha ) {
				if ( '' !== $tmp ) { @unlink( $tmp ); }
				return [ $n, 'could not read back the download of "' . $name . '"' ];
			}
			// Content-addressed by the FULL digest: the same artifact published twice is the same
			// object, a changed artifact can never reuse a CDN name cached for a year, and no member
			// can land on someone else's stored bytes by grinding a short prefix.
			$key = 'aq-library/' . substr( $sha, 0, 2 ) . '/' . $sha . '.' . self::ext( $name );
			// STORED THE WAY IT ARRIVED: the SVG as the string Svg::clean rebuilt, everything else as
			// the file it was streamed into. put_public_file() gives that path to curl and to copy()
			// without reading it into memory, so no leg of this loop ever holds a whole artifact —
			// which is what makes the advertised 512 MB ceiling something one request can deliver.
			$ok = $is_svg
				? Media::put_public( $key, $bytes, self::mime_of( $name ) )
				: Media::put_public_file( $key, $tmp, self::mime_of( $name ) );
			// Ours to remove, and only now: put_public_file() deliberately leaves the caller's file
			// alone, and the store has finished reading it by the time it answers.
			if ( '' !== $tmp ) { @unlink( $tmp ); }
			if ( ! $ok ) { return [ $n, 'could not store "' . $name . '"' ]; }
			Data::upsert( 'aq_library',
				[ 'nb_id' => (int) $r['id'], 'name_key' => sha1( $name ) ],
				[
					'author_id' => (int) $r['author_id'],
					'name'      => mb_substr( $name, 0, 400 ),
					'label'     => mb_substr( basename( $name ), 0, 200 ),
					'class'     => $cls,
					'mime'      => self::mime_of( $name ),
					// $len, never strlen($bytes): a streamed file never enters $bytes at all, so the
					// string that used to be measured here is now empty for everything but an SVG.
					'bytes'     => $len,
					'sha256'    => $sha,
					'cdn_key'   => $key,
					'created'   => Data::now(),
				] );
			$n++;
		}
		return [ $n, '' ];
	}

	/**
	 * Un-list every Library row of this work that is NOT in the current selection.
	 *
	 * DELETE rather than orphan with nb_id = 0: UNIQUE (nb_id, name_key) means the SECOND
	 * de-selection of the same filename would collide with the first orphan and the update would
	 * silently fail, leaving a live Library row for a file the author had removed. The OBJECT goes
	 * too, unless another Library row still names the same content-addressed key — de-selecting a
	 * file has to stop it being downloadable, not merely stop it being listed.
	 */
	private static function prune( $r, $sel ) {
		global $wpdb;
		$L    = Data::t( 'aq_library' );
		$keys = array_map( 'sha1', (array) $sel );
		$rows = Data::all( "SELECT id, name_key, cdn_key FROM $L WHERE nb_id = %d", [ (int) $r['id'] ] );
		foreach ( $rows as $row ) {
			if ( in_array( (string) $row['name_key'], $keys, true ) ) { continue; }
			// Anything already attached to a post keeps its row: deleting it would blank an
			// attachment sitting in someone's timeline. It stops being newly attachable anyway,
			// because Kernel::library joins on a PUBLISHED work.
			if ( (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_post_media' ) . ' WHERE lib_id = %d', [ (int) $row['id'] ] ) > 0 ) { continue; }
			$id  = (int) $row['id'];
			$key = (string) $row['cdn_key'];
			$wpdb->delete( $L, [ 'id' => $id ], [ '%d' ] );
			// AND THE BYTES (2026-08-16). Deleting the row alone left the object on the CDN with its
			// URL still answering — and the likeliest reason an author drops a file from their
			// selection is that it should not have been published at all. "Unlisted but still
			// downloadable by anyone who has the link" is not what un-publishing means, and the note
			// that used to be here ("the key is the sha256, so another work may be serving the very
			// same object") was a reason to CHECK, not a reason to keep every object forever.
			if ( '' !== $key ) {
				Media::destroy( $key, static function ( $k ) use ( $L ) {
					return (int) Data::col( "SELECT COUNT(*) FROM $L WHERE cdn_key = %s", [ $k ] ) > 0;
				} );
			}
		}
	}

	/**
	 * Drop this work's Library listings entirely — used when the work itself is removed.
	 *
	 * `prune` with an EMPTY selection is exactly "nothing of this work stays listed", including its
	 * own skip for rows already attached to a post: a removed work must stop feeding the shared
	 * shelf, but it must not blank an attachment sitting in someone's timeline. Each object goes with
	 * its row unless another row still names the same key (prune's shared-key check).
	 */
	public static function unlist( $r ) {
		if ( ! $r || ! isset( $r['id'] ) ) { return; }
		self::prune( $r, [] );
	}

	/** Public shape of one Library item. */
	public static function lib_card( $row ) {
		return [
			'id'     => (int) $row['id'],
			'nb_id'  => (int) $row['nb_id'],
			'name'   => (string) $row['name'],
			'label'  => (string) $row['label'],
			'class'  => (string) $row['class'],
			'mime'   => (string) $row['mime'],
			'bytes'  => (int) $row['bytes'],
			'sha256' => (string) $row['sha256'],
			'url'    => Media::url( (string) $row['cdn_key'] ),
			'uses'   => (int) $row['uses'],
		];
	}

	/**
	 * GET library — everything published, for everyone.
	 *
	 * The point of the reset: a reproducible artifact is not locked inside the work that made it.
	 * Any member can browse this and attach any item to their own post, with provenance attached.
	 */
	public static function library( $req ) {
		Notebook::ensure_tables();
		$cls   = sanitize_key( (string) Rest::p( $req, 'class', '' ) );
		$mine  = (bool) Rest::pint( $req, 'mine', 0 );
		$where = 'l.nb_id > 0';
		$args  = [];
		if ( $cls ) { $where .= ' AND l.class = %s'; $args[] = $cls; }
		if ( $mine ) { $where .= ' AND l.author_id = %d'; $args[] = Rest::uid(); }
		$q = trim( (string) Rest::p( $req, 'q', '' ) );
		if ( '' !== $q ) { $where .= ' AND l.label LIKE %s'; $args[] = '%' . $q . '%'; }
		$cursor = Rest::pint( $req, 'cursor', 0 );
		if ( $cursor ) { $where .= ' AND l.id < %d'; $args[] = $cursor; }
		$rows = Data::all(
			'SELECT l.*, n.title AS nb_title, n.slug AS nb_slug, n.doi AS nb_doi, n.kg_url AS nb_kernel, n.author_id AS nb_author'
			. ' FROM ' . Data::t( 'aq_library' ) . ' l'
			. ' JOIN ' . Data::t( 'aq_notebooks' ) . " n ON n.id = l.nb_id AND n.status = 'published'"
			. ' WHERE ' . $where . ' ORDER BY l.id DESC LIMIT 48', $args );
		$items = [];
		foreach ( $rows as $row ) {
			$c = self::lib_card( $row );
			$c['work'] = [
				'id'     => (int) $row['nb_id'],
				'title'  => (string) $row['nb_title'],
				'slug'   => (string) $row['nb_slug'],
				'doi'    => (string) $row['nb_doi'],
				'kernel' => (string) $row['nb_kernel'],
				'author' => Notebook::author_card( (int) $row['nb_author'] ),
			];
			$items[] = $c;
		}
		$next = count( $items ) === 48 ? (int) end( $items )['id'] : null;
		return [ 'items' => $items, 'next' => $next ];
	}

	/** The one-line reason publication is refused, or '' when the checklist is clear. */
	public static function blocking_reason( $report ) {
		if ( ! is_array( $report ) || empty( $report['items'] ) ) {
			return 'Run the reproducibility checklist first.';
		}
		// Real failures first — an author with a private dataset should be told about the dataset,
		// not about the step they have not reached yet.
		foreach ( [ 'fail', 'skip' ] as $state ) {
			foreach ( $report['items'] as $i ) {
				if ( self::BLOCK === $i['severity'] && $state === $i['state'] ) {
					return $i['title'] . ' — ' . $i['detail'];
				}
			}
		}
		return '';
	}
}
