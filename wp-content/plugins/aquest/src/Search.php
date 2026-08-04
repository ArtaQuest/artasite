<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Unified cross-domain search (GET /search) — the backend for the Explore hub and the documented
 * public search API. A single query fans out across the server-backed domains (notebooks,
 * discussions, grants) and comes back as ONE envelope of keyset pages, so a client can render a
 * blended results page or page each domain independently (pass a domain's `next` back as
 * `cursor_<domain>`).
 *
 * `notebooks` is the platform's substrate — the published works — and it was missing here until
 * 2026-08-04: this endpoint could not return a single published work while /notebooks?q= found it,
 * so a developer following the docs got six empty buckets. `courses` is the mirror image: the
 * legacy platform was retired and its table purged 2026-07-13, so it is no longer QUERIED — the key
 * stays in the envelope (always empty) because dropping a key breaks every existing client.
 *
 * Topics and Causes are searched CLIENT-SIDE — they live in the client typology JSON and a tiny
 * aggregated causes payload the SPA already holds — so their keys are present but always empty
 * here; the client merges its own hits into the same shape. Keeping the keys makes the contract
 * stable regardless of where a domain is searched.
 *
 * Reuses the existing list shaper (Social::thread_card) so a search hit is byte-identical to the
 * same row on its own page; works and grants get a slim card (no assets/run state, no
 * member/meeting joins — a result row needs only the headline, not the whole page).
 */
final class Search {

	/** The domains this endpoint searches server-side; the rest are client-side (empty here). */
	const SERVER_DOMAINS = [ 'notebooks', 'discussions', 'grants' ];

	/** GET /search?q=&domains=&limit=&cursor_notebooks=&cursor_discussions=&cursor_grants= */
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
				'notebooks'   => $empty, // the published works — the substrate everything else hangs off
				'courses'     => $empty, // retired platform (purged 2026-07-13): kept for shape, never filled
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

		if ( $want( 'notebooks' ) ) {
			// The same rows and the same filter as the public feed's GET /notebooks?q= (published only),
			// widened from title+abstract to include the SLUG: a stranger arriving from a citation has
			// the /nb/<id>/<slug> URL in hand, and searching what they were given must find the work.
			[ $rows, $next ] = Data::search_page( 'aq_notebooks', [ 'title', 'slug', 'abstract' ], $q, "status = 'published'", [], Rest::pint( $req, 'cursor_notebooks', 0 ), $limit );
			$out['results']['notebooks'] = [ 'items' => array_map( [ self::class, 'notebook_card' ], $rows ), 'next' => $next ];
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

	/**
	 * Slim card for a published work — the headline fields a result row shows. Deliberately not
	 * Notebook::card (which carries the feed's assets, hero and Kaggle checklist state); the keys it
	 * does share are spelled the SAME, so one component renders a search hit and a feed card alike.
	 * The author block is Notebook::author_card verbatim, so a member looks identical everywhere.
	 */
	public static function notebook_card( $r ) {
		return [
			'id'           => (int) $r['id'],
			'kind'         => (string) $r['kind'],
			'slug'         => (string) $r['slug'],
			'title'        => (string) $r['title'],
			'abstract'     => mb_substr( (string) ( $r['abstract'] ?? '' ), 0, 280 ),
			'thumb'        => (string) ( $r['thumb'] ?? '' ),
			'hearts'       => (int) $r['hearts'],
			'comments'     => (int) ( $r['comments'] ?? 0 ),
			'views'        => (int) ( $r['view_count'] ?? 0 ),
			// The citation of record, member-facing: ONLY the /d/n<id> short link (never the provider).
			'doi_link'     => ( (string) ( $r['doi'] ?? '' ) !== '' ) ? Doi::nb_link( (int) $r['id'] ) : '',
			// The work is credited to its KAGGLE author; the member below is whoever brought it here.
			'kaggle'       => [
				'owner'  => (string) ( $r['kg_owner'] ?? '' ),
				'author' => (string) ( ( Data::dec( $r['kg_facts'] ?? '' ) ?: [] )['author'] ?? '' ),
				'url'    => (string) ( $r['kg_url'] ?? '' ),
			],
			'author'       => Notebook::author_card( (int) $r['author_id'] ),
			'published_at' => (int) $r['published_at'],
		];
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
