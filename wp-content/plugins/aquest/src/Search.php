<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Unified cross-domain search (GET /search) — the backend for the Explore hub. A single query
 * fans out across the server-backed domains (courses, discussions, grants) and comes back as ONE
 * envelope of keyset pages, so the SPA can render a blended results page or page each domain
 * independently (pass a domain's `next` back as `cursor_<domain>`).
 *
 * Topics and Causes are searched CLIENT-SIDE — they live in the client typology JSON and a tiny
 * aggregated causes payload the SPA already holds — so their keys are present but always empty
 * here; the client merges its own hits into the same shape. Keeping the keys makes the contract
 * stable regardless of where a domain is searched.
 *
 * Reuses the existing list shapers (Courses::card, Social::thread_card) so a search hit is
 * byte-identical to the same row on its own page; grants get a slim card (no member/meeting joins —
 * a result row needs only the headline, not the claim panel).
 */
final class Search {

	/** The domains this endpoint searches server-side; the rest are client-side (empty here). */
	const SERVER_DOMAINS = [ 'courses', 'discussions', 'grants' ];

	/** GET /search?q=&domains=&limit=&cursor_courses=&cursor_discussions=&cursor_grants= */
	public static function all( $req ) {
		$q       = trim( (string) Rest::p( $req, 'q', '' ) );
		$limit   = max( 1, min( 24, Rest::pint( $req, 'limit', 8 ) ) );
		$domains = array_filter( array_map( 'trim', explode( ',', (string) Rest::p( $req, 'domains', implode( ',', self::SERVER_DOMAINS ) ) ) ) );
		$want    = fn( $d ) => in_array( $d, $domains, true );

		// Stable envelope. Topics/causes stay empty (client-side); every key is always present.
		$empty = [ 'items' => [], 'next' => null ];
		$out   = [
			'q'       => $q,
			'results' => [
				'courses'     => $empty,
				'topics'      => $empty, // searched client-side over the typology JSON
				'groups'      => $empty, // a topic's individual groups (options), searched client-side
				'grants'      => $empty,
				'discussions' => $empty,
				'causes'      => $empty, // searched client-side over the aggregated causes payload
			],
		];

		// Empty query → empty envelope (never scan a table for nothing).
		if ( $q === '' ) { return $out; }
		// Public LIKE scans — a fixed window guards against abuse without hurting normal typing.
		if ( Rest::throttle( 'search', 60, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }

		if ( $want( 'courses' ) ) {
			// Expand to topic-keyword-matched courses (e.g. "zoroastrianism" → also return
			// courses whose topic = "humanities") so searching a keyword surfaces the full topic.
			$kw_slug = Topics::keyword_to_slug( $q );
			if ( $kw_slug !== Topics::OTHER ) {
				$like = '%' . $GLOBALS['wpdb']->esc_like( $q ) . '%';
				[ $rows, $next ] = Data::page( 'aq_courses', "status = 'publish' AND (title LIKE %s OR channel LIKE %s OR topic = %s)", [ $like, $like, $kw_slug ], Rest::pint( $req, 'cursor_courses', 0 ), $limit );
			} else {
				[ $rows, $next ] = Data::search_page( 'aq_courses', [ 'title', 'channel' ], $q, "status = 'publish'", [], Rest::pint( $req, 'cursor_courses', 0 ), $limit );
			}
			// Shape via Courses::cards (not a per-row card map): cards() pre-batches every hit's LIVE
			// comment-rate in ONE query, so the Explore grid shows the same honest "/day" badge as the
			// catalogue — never the catalogue-resync-frozen rank_score 0 that dropped it — and without an
			// N+1 live-rate lookup per result (ticket #105).
			$out['results']['courses'] = [ 'items' => Courses::cards( $rows ), 'next' => $next ];
		}
		if ( $want( 'discussions' ) ) {
			[ $rows, $next ] = Data::search_page( 'aq_threads', [ 'title' ], $q, "status = 'publish'", [], Rest::pint( $req, 'cursor_discussions', 0 ), $limit );
			$out['results']['discussions'] = [ 'items' => array_map( [ Social::class, 'thread_card' ], $rows ), 'next' => $next ];
		}
		if ( $want( 'grants' ) ) {
			[ $rows, $next ] = Data::search_page( 'aq_grants', [ 'title', 'funder', 'summary' ], $q, 'active = 1', [], Rest::pint( $req, 'cursor_grants', 0 ), $limit );
			$out['results']['grants'] = [ 'items' => array_map( [ self::class, 'grant_card' ], $rows ), 'next' => $next ];
		}
		return $out;
	}

	/** Slim grant card for a search hit — headline fields only (no registrants/meetings joins). */
	public static function grant_card( $g ) {
		return [
			'id'             => (int) $g['id'],
			'slug'           => (string) $g['slug'],
			'title'          => (string) $g['title'],
			'funder'         => (string) $g['funder'],
			'url'            => (string) $g['url'],
			'country'        => (string) $g['country'],
			'category'       => (string) $g['category'],
			'amount_display' => (string) $g['amount_display'],
			'amount_cad'     => (int) $g['amount_cad'],
			'deadline'       => (string) $g['deadline'],
			'deadline_type'  => (string) $g['deadline_type'],
			'estimated'      => ! empty( $g['estimated'] ),
			'fit'            => (int) $g['fit'],
			'summary'        => (string) $g['summary'],
		];
	}
}
