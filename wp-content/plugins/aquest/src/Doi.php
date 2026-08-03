<?php
namespace AQ;

/**
 * DOI short links — /d/{code} (operator order 2026-07-13: the archive provider must never appear
 * in the frontend; every citable link is a clean ArtaQuest short link).
 *
 * Codes:  p<id> → an accepted research submission's DOI (aq_submissions)
 *         a<id> → a published ArtaDemo animation's DOI (aq_demo_subs)
 *
 * The short link 301s to the DOI resolver (https://doi.org/…), which is provider-neutral; the
 * raw DOI string and the archive's record page are never rendered anywhere member-facing —
 * surfaces display https://artaquest.com/d/p24 instead. No rewrite rules (nothing to flush):
 * a parse_request path check.
 */
class Doi {

	/** The member-facing short link for a research submission. */
	public static function paper_link( $id ) {
		return home_url( '/d/p' . (int) $id );
	}

	/** The member-facing short link for an ArtaDemo animation submission. */
	public static function demo_link( $id ) {
		return home_url( '/d/a' . (int) $id );
	}

	/** The member-facing short link for a published feed notebook. */
	public static function nb_link( $id ) {
		return home_url( '/d/n' . (int) $id );
	}

	/** parse_request — intercept /d/{code} and 301 to the DOI resolver. */
	public static function maybe_redirect() {
		$path = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_parse_url( (string) $_SERVER['REQUEST_URI'], PHP_URL_PATH ) : '';
		if ( ! preg_match( '#^/d/([pan])([0-9]{1,10})/?$#', $path, $m ) ) { return; }
		$doi = '';
		if ( $m[1] === 'p' ) {
			$row = Data::one( 'SELECT doi FROM ' . Data::t( 'aq_submissions' ) . " WHERE id = %d AND doi <> ''", [ (int) $m[2] ] );
			$doi = $row ? (string) $row['doi'] : '';
		} elseif ( $m[1] === 'n' ) {
			$row = Data::one( 'SELECT doi FROM ' . Data::t( 'aq_notebooks' ) . " WHERE id = %d AND doi <> ''", [ (int) $m[2] ] );
			$doi = $row ? (string) $row['doi'] : '';
		} else {
			$row = Data::one( 'SELECT doi FROM ' . Data::t( 'aq_demo_subs' ) . " WHERE id = %d AND doi <> ''", [ (int) $m[2] ] );
			$doi = $row ? (string) $row['doi'] : '';
		}
		if ( $doi === '' ) {
			wp_safe_redirect( home_url( '/research/' ), 302 );
			exit;
		}
		// The DOI resolver is provider-neutral; permanent, cacheable. Encode per segment so the
		// identifier's own slashes survive (10.5281/... must not become 10.5281%2F...).
		header( 'Cache-Control: public, max-age=86400' );
		wp_redirect( 'https://doi.org/' . implode( '/', array_map( 'rawurlencode', explode( '/', $doi ) ) ), 301 );
		exit;
	}
}
