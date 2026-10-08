<?php
/**
 * The public notebook mirror — how a published work opens in Colab and Kaggle with NO sign-in and
 * NO permission prompt (operator, 2026-10-08: "permission asked when trying to run on colab").
 *
 * **Why not the gist any more.** Every stored `colab_url` was `colab.research.google.com/gist/…`.
 * Colab's /gist/ route does not just read a public gist: it stops on "waiting for authorization
 * from GitHub" and sends the reader to a GitHub OAuth screen asking for `repo,gist` (read AND
 * write, public AND private) before it shows a single cell. Two of the three stored links also
 * named the wrong owner (`artaquest`; the gists belong to `artafather`). Colab's /github/ route,
 * on the other hand, opens a notebook in a PUBLIC repository anonymously. So every published
 * notebook is mirrored, verbatim, to the public repository `ArtaQuest/artabooks` — by that
 * repository's own scheduled workflow, which reads this site's public API (`notebooks`,
 * `notebooks/{id}/ipynb`). No credential is involved anywhere: nothing here writes to GitHub.
 *
 * **The path is computed, not stored**: `nb/<id>/<name>.ipynb`, where <name> is the slug folded to
 * the same charset as the site's own download filename (artaquest-web lib/pykernel.ts ipynbHref),
 * so both sides agree without a lookup table.
 *
 * **A link is offered only once the file is really there.** The mirror runs every 15 minutes, so a
 * work published a minute ago has no public copy yet; a Colab link to a 404 would be worse than the
 * download-and-open fallback the client already has. The answer is cached (a day when present, ten
 * minutes when absent), and the list endpoint only ever reads the cache — a feed render never waits
 * on GitHub.
 */

namespace AQ;

defined( 'ABSPATH' ) || exit;

final class Mirror {

	const REPO   = 'ArtaQuest/artabooks';
	const BRANCH = 'main';

	/** The repository path for a work: nb/<id>/<folded-slug>.ipynb. */
	public static function path( $r ) {
		$name = strtolower( (string) ( $r['slug'] ?? '' ) );
		$name = trim( (string) preg_replace( '~[^a-z0-9-]+~', '-', $name ), '-' );
		$name = substr( $name, 0, 60 );   // NO re-trim after the cut: ipynbHref and tools/sync.py do not either
		return 'nb/' . (int) ( $r['id'] ?? 0 ) . '/' . ( '' !== $name ? $name : 'notebook' ) . '.ipynb';
	}

	/** The anonymously fetchable bytes — what Kaggle's import form reads. */
	public static function raw_url( $r ) {
		return 'https://raw.githubusercontent.com/' . self::REPO . '/' . self::BRANCH . '/' . self::path( $r );
	}

	/**
	 * Whether the mirror holds this work yet. `$probe` false = cache only (never a network call).
	 * Only published works are mirrored, so nothing else is ever probed.
	 */
	public static function has( $r, $probe = true ) {
		if ( 'published' !== (string) ( $r['status'] ?? '' ) ) { return false; }
		$key  = 'aq_mirror_' . md5( self::path( $r ) );
		$seen = get_transient( $key );
		if ( false !== $seen ) { return 'y' === $seen; }
		if ( ! $probe ) { return false; }
		$resp = wp_remote_head( self::raw_url( $r ), [ 'timeout' => 4, 'redirection' => 0, 'user-agent' => 'ArtaQuest-Notebooks' ] );
		if ( is_wp_error( $resp ) ) { return false; }   // GitHub unreachable: answer no, cache nothing
		$ok = 200 === (int) wp_remote_retrieve_response_code( $resp );
		set_transient( $key, $ok ? 'y' : 'n', $ok ? DAY_IN_SECONDS : 10 * MINUTE_IN_SECONDS );
		return $ok;
	}

	/** One-click Colab, no prompt; '' until the mirror has the file. */
	public static function colab_url( $r, $probe = true ) {
		return self::has( $r, $probe )
			? 'https://colab.research.google.com/github/' . self::REPO . '/blob/' . self::BRANCH . '/' . self::path( $r )
			: '';
	}

	/** Kaggle's "new notebook from this file" form, pointed at the exact published bytes. */
	public static function kaggle_import_url( $r, $probe = true ) {
		return self::has( $r, $probe )
			? 'https://www.kaggle.com/kernels/welcome?src=' . rawurlencode( self::raw_url( $r ) )
			: '';
	}
}
