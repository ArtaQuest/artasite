<?php
/**
 * GitHub gists — the source-code CDN, and the only thing that makes a one-click Colab link possible.
 *
 * Operator, 2026-07-29: *"ensure that each submission is properly creating the gist on github which
 * is our source codes CDN"*, *"which then allow colab links creations"*. This restores the pipeline
 * purged on 2026-07-26 (commit f9850bc0), deliberately and with the operator's instruction.
 *
 * **Why a gist is not optional here.** Colab opens a notebook from Drive, GitHub, a gist, or an
 * upload — there is NO open-by-URL form. Serving a perfectly good `.ipynb` from our own domain gets
 * a member no closer to Colab than a download does. A public gist is the cheapest address Colab
 * will accept, which is exactly why this project used one before, and why the middle rung of the
 * three-tier ladder (local -> Colab -> Kaggle) needs it back.
 *
 * **It syncs at SUBMISSION, not at publication.** The tiers are a development ladder: a member
 * writes locally, takes the heavy run to Colab, then does the final run on Kaggle. A Colab link
 * that only appears after publication arrives one step too late to be used for any of that. So
 * `Kernel::store()` — the single place the Kaggle source lands, for both import and re-check —
 * calls this.
 *
 * **Idempotent by construction.** The gist id and its filename are both recoverable from the stored
 * `colab_url`, so a re-check PATCHes the existing gist rather than minting a rival copy, and the
 * filename never changes underneath it (renaming a gist file through this API means sending the old
 * key with a new `filename`, and getting that wrong silently leaves TWO files in one gist).
 *
 * Dormant without `GITHUB_GIST_TOKEN` in the Vault: every entry point returns the existing value, so
 * a missing credential costs a feature, never a submission. Same for a GitHub outage — a failed
 * sync returns what was already stored rather than blanking a link that still works.
 */

namespace AQ;

defined( 'ABSPATH' ) || exit;

final class Gist {

	const API     = 'https://api.github.com/gists';
	const TIMEOUT = 25;

	/** A notebook far past this is not something Colab will open happily, and GitHub truncates it. */
	const MAX_BYTES = 900000;

	/**
	 * Mirror this work's notebook source to its gist and return the Colab URL.
	 *
	 * Returns the EXISTING `colab_url` unchanged on every failure path (no token, no source, too
	 * large, GitHub down, malformed response) — never '', because blanking a working link is a
	 * worse outcome than a stale one.
	 *
	 * @param array  $row    The aq_notebooks row (needs id, title, kind, colab_url).
	 * @param string $source The notebook JSON to publish. Defaults to the row's stored ipynb.
	 */
	public static function sync( $row, $source = null ) {
		$have  = (string) ( $row['colab_url'] ?? '' );
		$token = trim( (string) Secrets::get( 'GITHUB_GIST_TOKEN' ) );
		$json  = null === $source ? (string) ( $row['ipynb'] ?? '' ) : (string) $source;
		if ( '' === $token || '' === $json || strlen( $json ) > self::MAX_BYTES ) { return $have; }

		[ $gid, $fname ] = self::parse( $have );
		if ( '' === $fname ) { $fname = self::filename( $row ); }

		$body = wp_json_encode( [
			'description' => self::describe( $row ),
			'public'      => true,
			'files'       => [ $fname => [ 'content' => $json ] ],
		] );
		if ( ! is_string( $body ) ) { return $have; }

		// POST mints, PATCH updates in place. GitHub accepts POST on /gists and PATCH on /gists/{id};
		// there is no upsert, so the stored id is what decides which one this is.
		$url  = '' !== $gid ? self::API . '/' . rawurlencode( $gid ) : self::API;
		$resp = wp_remote_request( $url, [
			'method'  => '' !== $gid ? 'PATCH' : 'POST',
			'timeout' => self::TIMEOUT,
			'headers' => [
				'Authorization'        => 'Bearer ' . $token,
				'Accept'               => 'application/vnd.github+json',
				'X-GitHub-Api-Version' => '2022-11-28',
				'User-Agent'           => 'ArtaQuest-Notebooks',
				'Content-Type'         => 'application/json',
			],
			'body'    => $body,
		] );
		if ( is_wp_error( $resp ) ) { return $have; }

		$code = (int) wp_remote_retrieve_response_code( $resp );
		// A stored gist that has been deleted on GitHub answers 404 to PATCH. Mint a fresh one
		// rather than leaving the work pointing at nothing for ever.
		if ( 404 === $code && '' !== $gid ) {
			$row['colab_url'] = '';
			return self::sync( $row, $json );
		}
		if ( $code < 200 || $code >= 300 ) { return $have; }

		$j = json_decode( wp_remote_retrieve_body( $resp ), true );
		if ( ! is_array( $j ) ) { return $have; }
		$id = (string) ( $j['id'] ?? '' );
		if ( '' === $id ) { return $have; }
		$owner = (string) ( $j['owner']['login'] ?? 'artaquest' );
		// Read the filename BACK from GitHub rather than trusting the one we sent: it normalises
		// some names, and a Colab URL whose last segment does not match the gist's file 404s.
		$files = is_array( $j['files'] ?? null ) ? $j['files'] : [];
		$name  = $files ? (string) array_key_first( $files ) : $fname;

		return 'https://colab.research.google.com/gist/'
			. rawurlencode( $owner ) . '/' . rawurlencode( $id ) . '/' . rawurlencode( $name );
	}

	/**
	 * Sync and persist, when the source actually changed.
	 *
	 * `Kernel::store()` runs on every re-check, and most re-checks re-fetch an unchanged notebook —
	 * calling GitHub each time would spend rate limit to write bytes it already has.
	 */
	public static function sync_row( $row, $source ) {
		$source = (string) $source;
		if ( '' === $source ) { return; }
		$have = (string) ( $row['colab_url'] ?? '' );
		// Nothing to do when the bytes are identical AND a link already exists.
		if ( '' !== $have && $source === (string) ( $row['ipynb'] ?? '' ) ) { return; }
		$url = self::sync( $row, $source );
		if ( '' !== $url && $url !== $have ) {
			Data::update( 'aq_notebooks', [ 'colab_url' => mb_substr( $url, 0, 300 ) ], [ 'id' => (int) $row['id'] ] );
		}
	}

	/**
	 * wp-cli backfill — mirror works that have no gist yet.
	 *
	 *     studio wp eval 'echo AQ\Gist::backfill();'          # local
	 *     ssh artaquest "cd /srv/htdocs && wp eval 'echo AQ\\Gist::backfill();'"
	 *
	 * The sync runs from `Kernel::store()`, so a work only gets its gist when it is imported or
	 * re-checked. Everything submitted BEFORE the token was added would otherwise sit without a
	 * Colab link until someone happened to press Re-check — which is not a plan. Ordered oldest
	 * first and capped, so it can be run repeatedly rather than as one long request.
	 */
	public static function backfill( $limit = 25 ) {
		if ( '' === trim( (string) Secrets::get( 'GITHUB_GIST_TOKEN' ) ) ) {
			return "GITHUB_GIST_TOKEN is not set — add it in wp-admin > AQ Vault (scope: gist).\n";
		}
		$rows = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_notebooks' )
			. " WHERE status <> 'removed' AND colab_url = '' AND ipynb <> '' ORDER BY id ASC LIMIT %d",
			[ max( 1, (int) $limit ) ]
		);
		$done = 0;
		$out  = '';
		foreach ( $rows as $r ) {
			$url = self::sync( $r, (string) $r['ipynb'] );
			if ( '' !== $url ) {
				Data::update( 'aq_notebooks', [ 'colab_url' => mb_substr( $url, 0, 300 ) ], [ 'id' => (int) $r['id'] ] );
				$done++;
				$out .= '  #' . (int) $r['id'] . ' ' . $url . "\n";
			} else {
				$out .= '  #' . (int) $r['id'] . " FAILED\n";
			}
		}
		return 'mirrored ' . $done . ' of ' . count( $rows ) . " work(s)\n" . $out;
	}

	/** gist id + filename out of a stored Colab URL; ['',''] when there is none to read. */
	private static function parse( $colab ) {
		$colab = (string) $colab;
		if ( '' === $colab ) { return [ '', '' ]; }
		// Delimiter is ~, NOT # — the class has to exclude a literal '#' (a fragment ends the
		// filename), and a '#' delimiter terminates the pattern right there. PHP then warns
		// "Unknown modifier ']'" and preg_match returns false for EVERY input, so parse() would
		// never find an existing gist and every re-check would mint a rival instead of PATCHing.
		// Caught by running it, not by reading it.
		if ( ! preg_match( '~/gist/[^/]+/([0-9a-fA-F]+)/([^/?#]+)~', $colab, $m ) ) { return [ '', '' ]; }
		return [ (string) $m[1], rawurldecode( (string) $m[2] ) ];
	}

	/**
	 * A stable, readable filename. The notebook id is in it because the title is editable and two
	 * works may share one; the extension matters because Colab and Jupyter both name the notebook
	 * from the URL's last segment.
	 */
	private static function filename( $row ) {
		$slug = sanitize_title( (string) ( $row['title'] ?? '' ) );
		$slug = '' !== $slug ? mb_substr( $slug, 0, 48 ) : 'notebook';
		return $slug . '-nb' . (int) ( $row['id'] ?? 0 ) . '.ipynb';
	}

	/** What a stranger sees on the gist itself — it is a public page, so it carries the citation. */
	private static function describe( $row ) {
		$cite = class_exists( '\\AQ\\Doi' ) ? Doi::nb_link( (int) $row['id'] ) : '';
		return 'ArtaQuest — "' . (string) ( $row['title'] ?? 'Untitled' ) . '" (work #' . (int) $row['id'] . ').'
			. ' The submitted Kaggle notebook, mirrored so it opens in Colab.'
			. ( '' !== $cite ? ' Cite: ' . $cite : '' );
	}
}
