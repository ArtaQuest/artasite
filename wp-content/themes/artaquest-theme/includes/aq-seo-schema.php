<?php
/**
 * Site-wide + per-page schema.org JSON-LD — classical-SEO + LLM-crawler friendly.
 * Emits a single @graph in <head>: Organization + WebSite always; then the Notebook Feed
 * surfaces (CollectionPage on /works/ + the eleven kind hubs; the per-kind typed node for one
 * published notebook at /nb/<id>/), Person/ProfilePage (/u/<slug>/), AboutPage and FAQPage.
 * The PUBLIC thread DiscussionForumPosting (/discussions/?thread=) is emitted by aq_app_head_meta()
 * in aq-app.php using the aq_seo_forum_author() / aq_seo_forum_comment() / aq_seo_forum_replies()
 * helpers below.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The active locale as BCP-47, for `inLanguage`.
 *
 * Every node below hardcoded 'en'. On /fa/ and /ar/ that made the structured data contradict the
 * markup — <html lang="fa" dir="rtl"> and a Persian hreflang, against a graph asserting the resource
 * is English. Where the two disagree Google trusts inLanguage, so ~133 locales' worth of pages were
 * classified as English duplicates of one another.
 *
 * Same lowercase-language / uppercase-region normalisation aq_app_hreflang_links() already applies,
 * so the two never drift (zh-tw -> zh-TW).
 */
function aq_seo_bcp47() {
	$code = class_exists( '\\AQ\\I18n' ) ? \AQ\I18n::current() : 'en';
	if ( ! $code ) {
		return 'en';
	}
	return strpos( $code, '-' ) !== false
		? preg_replace_callback( '/-([a-z]+)$/', function ( $r ) { return '-' . strtoupper( $r[1] ); }, $code )
		: $code;
}

/**
 * THE official ArtaQuest accounts — one PHP source of truth, keyed by platform.
 *
 * WHY THIS EXISTS: the list used to be copy-pasted into the Organization node's `sameAs` AND into
 * templates/footer/index.php, each with its OWN get_option() default. Because the aq_social_*
 * options are unset in production, the two fell back to different literals and drifted apart —
 * the footer kept serving `x.com/artaquestorg`, which 404s, on the /?s= search route long after
 * the handle moved to `arta_quest`. (A comment in this file even claimed that template no longer
 * existed; it does.) Two PHP copies could always have shared a constant, so now they do.
 *
 * A dead entry is worse than a missing one: Google FOLLOWS these, and an unresolvable profile
 * weakens the entity rather than describing it. Verify a URL resolves before adding it.
 *
 * ⚠️ STILL MIRRORED in artaquest-web/src/components/Footer.tsx (SOCIALS) — the visible SPA footer.
 * That one is React and genuinely cannot share this constant, so it remains a hand-kept copy:
 * change a handle here and you MUST change it there too.
 *
 * @return array<string,string> platform key => profile URL (empty entries filtered out).
 */
function aq_social_profiles() {
	return array_filter( array(
		'youtube'   => get_option( 'aq_social_youtube', 'https://www.youtube.com/@ArtaQuest' ),
		'linkedin'  => get_option( 'aq_social_linkedin', 'https://www.linkedin.com/company/artaquest' ),
		// GitHub is not decoration here: it is the source-code CDN every submitted notebook is
		// mirrored to as a public gist, which is what makes the one-click Colab link possible
		// (src/Gist.php). Verified 2026-07-30: the account resolves and holds the gists.
		'github'    => get_option( 'aq_social_github', 'https://github.com/ArtaQuest' ),
		// Kaggle is the least decorative link on this list (operator 2026-08-02). Every submission IS
		// a public Kaggle notebook that has been run, so this is the provenance of the whole substrate
		// and belongs in `sameAs` as much as in the footer. Points at the FOUNDATION'S ORGANISATION
		// rather than the artafather account it used to (operator 2026-08-13): the org is the entity
		// this schema is about, and a personal account is a different one.
		'kaggle'    => get_option( 'aq_social_kaggle', 'https://www.kaggle.com/organizations/artaquest-foundation' ),
		// X, restored 2026-08-15 (operator), pointing at @artafather. Two things worth knowing before
		// anyone "corrects" this:
		//   • It is NOT the old @arta_quest, which is dead — 404 on 2026-08-13 when X was pulled, and
		//     404 again today. The handle changed; the entry did not merely come back.
		//   • @artafather is the founder's handle, and the Kaggle line two rules up was deliberately
		//     moved OFF that same account so `sameAs` would name the ORGANISATION. The difference is
		//     that a Kaggle ORG account exists and an X one does not: there is no @artaquest to point
		//     at, so this is the platform's only X presence, and the footer presents it as such.
		//     If an organisation account is ever created, move this the way Kaggle was moved.
		'x'         => get_option( 'aq_social_x', 'https://x.com/artafather' ),
		/*
		 * PARKED. 2026-07-31 (operator: "only keep ista, x, linked, github for now", then "replace
		 * insta with youtube"). X was removed 2026-08-13 and RESTORED 2026-08-15 under a new handle —
		 * it is live above, not parked. These are OUT of both the footer and `sameAs` together, per
		 * the sync rule above — a schema link the footer dropped is a claim about an account nobody
		 * can find.
		 * "For now": the handles are kept here so restoring one is a single uncommented line, and so
		 * the next person does not have to go and rediscover them.
		 *   'instagram' => 'https://www.instagram.com/arta_quest'   (resolves 200; swapped for YouTube)
		 *   'tiktok'    => 'https://www.tiktok.com/@arta_quest'
		 *   'facebook'  => 'https://www.facebook.com/artaquest/'
		 *   'pinterest' => 'https://pinterest.com/artaquest/'
		 * Restoring one means adding it BOTH here and to SOCIALS in Footer.tsx.
		 */
	) );
}

/**
 * A schema.org author node (Person) for a forum post or reply that ALWAYS carries a `url`. Google's
 * DiscussionForumPosting reports "Missing field 'url' in 'author'" when it is absent, so a real member
 * links to their public profile (/u/<nicename>/) and a profile-less / since-deleted author falls back to
 * the site root — the field is then never missing. Shared by the section board (aq-seo-schema) and the
 * public thread (aq-app) emitters so the two stay identical.
 *
 * @param string $display_name member display name (may be empty).
 * @param string $nicename     user_nicename, or '' when there is no public profile.
 * @return array Person node with name + url.
 */
function aq_seo_forum_author( $display_name, $nicename ) {
	$nice = sanitize_title( (string) $nicename );
	$name = trim( (string) $display_name );
	return array(
		'@type' => 'Person',
		'name'  => '' !== $name ? $name : 'Quester',
		'url'   => '' !== $nice ? home_url( '/u/' . $nice . '/' ) : home_url( '/' ),
	);
}

/**
 * A schema.org Comment node for a forum reply, or null when it has no usable text. Google holds every
 * Comment to the same bar as the posting — one of text/image/video PLUS an author — so a reply that is
 * empty after tag-stripping is SKIPPED rather than emitted text-less (an empty `text` itself trips the
 * critical "neither text, image, nor video" error). The author always carries a url (aq_seo_forum_author).
 *
 * A top-level comment's own replies are nested under the `comment` property: Google's
 * DiscussionForumPosting RECOMMENDS a comment carry its replies there, and Search Console warns
 * "missing field 'comment' (in 'comment')" when a comment that has replies omits them. The board threads
 * exactly ONE level deep (aq_comments.parent_id; see Schema), so a reply never has replies of its own —
 * these nested nodes are leaves and the helper never recurses past the single pass below.
 *
 * @param object $r       row with body, votes, created, display_name, user_nicename, and optional reply_count.
 * @param array  $replies optional reply rows (same shape as $r) to nest under this comment as `comment`.
 * @return array|null Comment node, or null when there is no text to show.
 */
function aq_seo_forum_comment( $r, $replies = array() ) {
	$text = trim( wp_strip_all_tags( isset( $r->body ) ? (string) $r->body : '' ) );
	if ( '' === $text ) {
		return null;
	}
	$node = array(
		'@type'       => 'Comment',
		'text'        => $text,
		'author'      => aq_seo_forum_author( isset( $r->display_name ) ? $r->display_name : '', isset( $r->user_nicename ) ? $r->user_nicename : '' ),
		'upvoteCount' => isset( $r->votes ) ? (int) $r->votes : 0,
	);
	if ( isset( $r->reply_count ) ) {
		$node['commentCount'] = (int) $r->reply_count;
	}
	// datePublished is REQUIRED on a Comment (Google holds a Comment to the same bar as the posting:
	// author + datePublished + one-of text/image/video). Always emit it — the real timestamp when known,
	// else the current time as a safe non-null fallback (every real row carries a created timestamp).
	$node['datePublished'] = gmdate( 'c', ! empty( $r->created ) ? (int) $r->created : time() );
	// Nested replies → schema.org `comment` (the field Search Console reported missing inside each
	// Comment). Each reply reuses this same builder (so it too carries author+url+datePublished+text and
	// any text-less one is dropped); replies are one level deep, so we pass no further replies down.
	if ( $replies ) {
		$children = array();
		foreach ( (array) $replies as $rep ) {
			$child = aq_seo_forum_comment( $rep );
			if ( $child ) {
				$children[] = $child;
			}
		}
		if ( $children ) {
			$node['comment'] = $children;
		}
	}
	return $node;
}

/**
 * Fetch the non-flagged direct replies for a set of top-level comment ids, grouped by parent id, so a
 * forum emitter can nest them under each Comment as schema.org `comment` (see aq_seo_forum_comment). One
 * batched query — NOT a per-comment N+1 — keyed on the indexed `parent` column; hate/fear (flagged)
 * replies are excluded to match how the competition and the top-level lists drop them. The total is
 * bounded (the boards thread one level, and top-level lists are already capped upstream).
 *
 * @param array $parent_ids top-level comment ids (only those with reply_count > 0 are worth passing).
 * @return array map of parent_id (int) → array of reply rows; empty when there are no ids/replies.
 */
function aq_seo_forum_replies( $parent_ids ) {
	$ids = array_values( array_unique( array_filter( array_map( 'absint', (array) $parent_ids ) ) ) );
	if ( ! $ids ) {
		return array();
	}
	global $wpdb;
	$place = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
	$rows  = $wpdb->get_results( $wpdb->prepare(
		"SELECT c.parent_id, c.body, c.votes, c.created, u.display_name, u.user_nicename
		   FROM {$wpdb->prefix}aq_comments c
		   LEFT JOIN {$wpdb->prefix}users u ON u.ID = c.author_id
		  WHERE c.parent_id IN ($place) AND c.flagged = 0
		  ORDER BY c.parent_id ASC, c.id ASC
		  LIMIT 200",
		$ids
	) );
	$by_parent = array();
	foreach ( (array) $rows as $row ) {
		$by_parent[ (int) $row->parent_id ][] = $row;
	}
	return $by_parent;
}

/**
 * The Person node for a work's `author`: the KAGGLE author when the submitter is someone else.
 *
 * Any member may submit any PUBLIC Kaggle kernel (operator 2026-07-28), so the ArtaQuest member on
 * a row is its SUBMITTER. Naming them as `author` in structured data would tell Google —
 * permanently, and at scale — that they wrote work they did not. kg_facts carries what Kaggle
 * itself reports and kg_owner is the handle; falling back to the submitter is right only when
 * there is no Kaggle identity at all (a pre-reset row).
 */
function aq_seo_work_author( $n, $author, $url ) {
	$facts = isset( $n->kg_facts ) ? json_decode( (string) $n->kg_facts, true ) : null;
	$kg    = is_array( $facts ) ? trim( (string) ( $facts['author'] ?? '' ) ) : '';
	$owner = isset( $n->kg_owner ) ? trim( (string) $n->kg_owner ) : '';
	if ( '' === $kg && '' !== $owner ) { $kg = $owner; }
	if ( '' !== $kg ) {
		return array(
			'@type' => 'Person',
			'name'  => $kg,
			'url'   => '' !== $owner ? 'https://www.kaggle.com/' . rawurlencode( $owner ) : $url,
		);
	}
	return array(
		'@type' => 'Person',
		'name'  => ( $author && $author->display_name !== '' ) ? $author->display_name : 'ArtaQuest member',
		'url'   => $author ? home_url( '/u/' . $author->user_nicename . '/' ) : $url,
	);
}

/**
 * schema.org node for a PUBLISHED feed notebook (/nb/<id>/(<slug>/)) — the page's OWN main
 * entity, typed sensibly per kind: Dataset for a dataset (Google Dataset Search) and a survey,
 * ScholarlyArticle for an article, VisualArtwork for a 2D/3D illustration, VideoGame for a 2D/3D
 * game, SoftwareSourceCode for a model, MusicRecording for a music track, and CreativeWork for a
 * 2D/3D animation. Every node states the platform's one principle in `genre`/`learningResourceType`-adjacent
 * fields honestly: the work IS a public Kaggle notebook that has been run. When a DOI is minted, the
 * permanent short link home_url('/d/n<id>') becomes the node's sameAs and the DOI its identifier.
 *
 * @param object $n published aq_notebooks row: id, kind, slug, title, abstract, thumb, doi,
 *                  published_at, author_id.
 * @return array typed schema.org node.
 */
function aq_seo_notebook( $n ) {
	$url    = aq_notebook_url( $n );
	$author = get_userdata( (int) $n->author_id );
	// The 11-kind roster (2026-07-22; music re-added as the eleventh, 2026-07-26). 3D kinds keep
	// the same schema.org type as their 2D sibling — the third dimension is an extra published
	// artifact, not a distinct schema type.
	$types  = array(
		'dataset'        => 'Dataset',
		'model'          => 'SoftwareSourceCode',
		'article'        => 'ScholarlyArticle',
		'survey'         => 'Dataset',
		'illustration2d' => 'VisualArtwork',
		'illustration3d' => 'VisualArtwork',
		'animation2d'    => 'CreativeWork',
		'animation3d'    => 'CreativeWork',
		'game2d'         => 'VideoGame',
		'game3d'         => 'VideoGame',
		'music'          => 'MusicRecording',
	);
	$kind = (string) $n->kind;
	$node = array(
		'@type'               => isset( $types[ $kind ] ) ? $types[ $kind ] : 'CreativeWork',
		'@id'                 => $url,
		'name'                => (string) $n->title,
		'url'                 => $url,
		'genre'               => $kind,
		'inLanguage'          => 'en',
		'isAccessibleForFree' => true,
		'encodingFormat'      => 'application/x-ipynb+json', // the work IS a public Kaggle notebook (Jupyter)
		// THE AUTHOR IS WHOEVER WROTE THE NOTEBOOK. Any member may submit any PUBLIC Kaggle kernel
		// (operator 2026-07-28), so the ArtaQuest member on a row is its SUBMITTER. Naming them as
		// `author` in structured data would tell Google — permanently, and at scale — that they
		// wrote work they did not. The Zenodo deposit already credits the Kaggle author; this must
		// agree with it. `contributor` records who brought it here.
		'author'              => aq_seo_work_author( $n, $author, $url ),
		'publisher'           => array(
			'@type' => array( 'Organization', 'NGO' ),
			'name'  => 'ArtaQuest Foundation',
			'@id'   => home_url( '/' ) . '#org',
		),
	);
	$ts = aq_notebook_published_ts( $n );
	if ( $ts ) {
		$node['datePublished'] = gmdate( 'c', $ts );
	}
	$abs = trim( wp_strip_all_tags( (string) $n->abstract ) );
	if ( '' !== $abs ) {
		$node['abstract']    = $abs;
		$node['description'] = mb_substr( $abs, 0, 300 );
	}
	if ( ! empty( $n->thumb ) ) {
		$node['image'] = (string) $n->thumb;
	}
	// The permanent DOI short link (/d/n<id>) is the canonical scholarly pointer once a DOI exists.
	if ( '' !== trim( (string) $n->doi ) ) {
		$node['sameAs']     = home_url( '/d/n' . (int) $n->id );
		$node['identifier'] = trim( (string) $n->doi );
	}
	// THE PROVENANCE, stated where a machine can read it. This platform's whole claim is that a work
	// IS a public Kaggle notebook that has been run, from public inputs, which anyone can re-run and
	// contradict — and the structured record said nothing about it. `isBasedOn` is the schema.org
	// property for "this derives from that resource"; `codeRepository` is what a search engine reads
	// to find the source of a SoftwareSourceCode. Both point at the kernel the checklist was read
	// from, so the citation, the DOI and the provenance all resolve to the same artefact.
	$kernel = isset( $n->kg_url ) ? trim( (string) $n->kg_url ) : '';
	if ( '' !== $kernel ) {
		$node['isBasedOn'] = $kernel;
		if ( 'SoftwareSourceCode' === $node['@type'] ) {
			$node['codeRepository'] = $kernel;
		}
	}
	if ( 'article' === $kind ) {
		$node['headline'] = (string) $n->title;
		$node['license']  = 'https://creativecommons.org/licenses/by/4.0/';
	}
	if ( 'music' === $kind ) {
		// byArtist is MusicRecording's canonical creator property — the same Person as `author`
		// (the notebook's author IS the composer; the model that renders the piece is theirs).
		$node['byArtist'] = $node['author'];
	}
	return $node;
}

add_action(
	'wp_head',
	function () {
		$home  = home_url( '/' );
		$nodes = array();

		// ── Site-wide: Organization + WebSite (sitelinks search box) ──
		// Typed as an NGO with its legal entity — ArtaQuest is run by the registered Canadian
		// not-for-profit "ArtaQuest Foundation" (matters for donors + grant-givers searching, and
		// for the knowledge panel). `name` stays the product brand "ArtaQuest" (brand-name is a flagged
		// user decision); only the settled legalName + nonprofit typing are added.
		$org = array(
			'@type'            => array( 'Organization', 'NGO' ),
			'@id'              => $home . '#org',
			'name'             => 'ArtaQuest',
			'legalName'        => 'ArtaQuest Foundation',
			'url'              => $home,
			'description'      => 'The notebook feed: every published work — surveys, datasets, models, articles, 2D and 3D illustrations, 2D and 3D animations, 2D and 3D games, and music — is a public Kaggle notebook that has been run, checked against Kaggle\'s public record and published by its own author with a permanent DOI short link.',
			'foundingLocation' => array( '@type' => 'Place', 'name' => 'Canada' ),
			'founder'          => array( '@id' => $home . '#founder' ),
			// Public contact point — feeds Google's knowledge panel and matches the /faq-contact/
			// page's "Email support" button. support@artaquest.org is the single canonical address.
			'contactPoint'     => array(
				'@type'       => 'ContactPoint',
				'email'       => 'support@artaquest.org',
				'contactType' => 'customer support',
			),
			// sameAs — the official profiles that are THIS entity elsewhere. This is how Google
			// resolves "ArtaQuest" the organisation from the many other things that string could
			// mean, and it is what a knowledge panel is assembled from; without it the org node
			// floats unanchored.
			//
			// The roster + the reasoning live on aq_social_profiles() above — the ONE PHP copy that
			// templates/footer/index.php now reads from too, so the schema and the rendered footer
			// can no longer disagree about which accounts exist.
			'sameAs'           => array_values( aq_social_profiles() ),
		);
		// Organization logo — the version-controlled brand mark (theme asset). NOT get_theme_mod(
		// 'custom_logo'): that still points at a deleted `artayab-*` attachment (404) from before the
		// rebrand, which would feed Google's knowledge panel a broken image.
		// This pointed at quest-logo-2x.png — the RETIRED magnifying-glass "Quest" wordmark, dropped
		// as the mark in 2026-05-30 — so the knowledge panel advertised a logo the site itself has
		// not shown for two months. Use the square brand avatar: Google wants >=112x112 and renders
		// the logo on a surface we don't control, so the opaque brand-space square is the safe
		// choice over the transparent mark (whose gold A is only ~1.8:1 on white).
		$org['logo'] = get_theme_file_uri( 'assets/brand/social-avatar-1024.png' );
		$nodes[] = $org;
		// The founder as a first-class entity (knowledge-graph), bidirectionally linked to the org.
		$nodes[] = array(
			'@type'    => 'Person',
			'@id'      => $home . '#founder',
			'name'     => 'Arash Ashrafnejad',
			'jobTitle' => 'Founder',
			'worksFor' => array( '@id' => $home . '#org' ),
			'url'      => $home . 'about/',
		);
		$nodes[] = array(
			'@type'            => 'WebSite',
			'@id'              => $home . '#website',
			'url'              => $home,
			'name'             => 'ArtaQuest',
			'publisher'        => array( '@id' => $home . '#org' ),
			'inLanguage'       => aq_seo_bcp47(),
			'potentialAction'  => array(
				'@type'       => 'SearchAction',
				'target'      => array( '@type' => 'EntryPoint', 'urlTemplate' => $home . '?s={search_term_string}' ),
				'query-input' => 'required name=search_term_string',
			),
		);


		// ── Public profile (/u/<slug>/) → ProfilePage + Person ──
		$slug = get_query_var( 'aq_profile' );
		if ( $slug ) {
			$u = get_user_by( 'login', sanitize_title( $slug ) );
			if ( ! $u ) {
				$u = get_user_by( 'slug', sanitize_title( $slug ) );
			}
			if ( $u ) {
				$purl   = home_url( '/u/' . $u->user_nicename . '/' );
				$person = array(
					'@type' => 'Person',
					'@id'   => $purl . '#person',
					'name'  => $u->display_name,
					'url'   => $purl,
					// Verify::avatar_url, not get_avatar_url — the picture the page actually shows, and
					// never a Gravatar URL, which is a hash of the member's email address. The
					// pre_get_avatar_data filter now covers the bare call too, but a schema.org emitter
					// naming a real person should say which resolver it means.
					'image' => class_exists( '\AQ\Verify' ) ? \AQ\Verify::avatar_url( $u->ID, 160 ) : '',
				);
				$bio = get_user_meta( $u->ID, 'description', true );
				if ( $bio ) {
					$person['description'] = wp_strip_all_tags( $bio );
				}
				$nodes[] = array(
					'@type'      => 'ProfilePage',
					'url'        => $purl,
					'mainEntity' => $person,
				);
			}
		}

		// ── About page → AboutPage about the Organization (ties /about/ to the #org entity) ──
		if ( is_page( 'about' ) ) {
			// `about` is the property that carries an AboutPage's subject; `mainEntity` stays as well so
			// the pre-existing edge is not dropped. isPartOf/inLanguage bring it in line with every
			// other node on the page — this was the only one emitting neither.
			$nodes[] = array(
				'@type'       => 'AboutPage',
				'@id'         => $home . 'about/#aboutpage',
				'url'         => $home . 'about/',
				'name'        => 'About ArtaQuest',
				// Describes what the PAGE is about, which since 2026-08-15 is chiefly its founder's own
				// account. `mentions` names him as an entity and points at his profile, so a search for
				// his name has an edge to follow from the page that actually tells his story.
				'description' => 'Why ArtaQuest exists, in the words of the person who runs it. Arash Ashrafnejad — born in Tehran, 1994 — on leaving a PhD in artificial intelligence to return to teaching, and on building a not-for-profit feed where every post is a public Kaggle notebook anyone can run again and check.',
				'inLanguage'  => aq_seo_bcp47(),
				'isPartOf'    => array( '@id' => $home . '#website' ),
				'about'       => array( '@id' => $home . '#org' ),
				'mainEntity'  => array( '@id' => $home . '#org' ),
				'mentions'    => array(
					'@type' => 'Person',
					'name'  => 'Arash Ashrafnejad',
					'url'   => $home . 'u/arash/',
					'jobTitle' => 'Founder',
					'worksFor' => array( '@id' => $home . '#org' ),
				),
			);
		}

		// ── FAQ page (/faq-contact/) → FAQPage (Q&A semantics for search + AI crawlers) ──
		if ( is_page( 'faq-contact' ) && function_exists( 'aq_faq_items' ) ) {
			$qa = array();
			foreach ( aq_faq_items() as $item ) {
				$qa[] = array(
					'@type'          => 'Question',
					'name'           => $item[0],
					'acceptedAnswer' => array( '@type' => 'Answer', 'text' => $item[1] ),
				);
			}
			if ( $qa ) {
				$nodes[] = array(
					'@type'      => 'FAQPage',
					'@id'        => $home . 'faq-contact/#faq',
					'url'        => $home . 'faq-contact/',
					'mainEntity' => $qa,
				);
			}
		}

		// ── Feed hubs (/works/ + the eleven kind hubs) → CollectionPage (+ ItemList) ──
		// These are is_404() SPA soft-routes, so WP emits no page schema; give crawlers a structured
		// collection — the hub's name + description + the most recent published notebooks as an
		// ItemList, each typed like its detail page (aq_seo_notebook's kind map). Read-only; the table
		// name is a fixed prefix and `status` is a literal; the kind is bound with a placeholder.
		// Guarded — the aq_notebooks table may not exist yet on a cold site.
		$aq_mkt_hub  = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
		$aq_mkt_hubs = function_exists( 'aq_feed_hubs' ) ? aq_feed_hubs() : array();
		if ( 'works' === $aq_mkt_hub || isset( $aq_mkt_hubs[ $aq_mkt_hub ] ) ) {
			$hurl = $home . $aq_mkt_hub . '/';
			$page = array(
				'@type'       => 'CollectionPage',
				'@id'         => $hurl . '#page',
				'url'         => $hurl,
				'name'        => 'works' === $aq_mkt_hub ? 'The Feed' : 'ArtaQuest ' . $aq_mkt_hubs[ $aq_mkt_hub ][0],
				'description' => 'works' === $aq_mkt_hub
					? 'Every published work on ArtaQuest across all eleven categories — each a public Kaggle notebook that has been run, checked against Kaggle\'s public record and published by its own author with a permanent DOI short link.'
					: $aq_mkt_hubs[ $aq_mkt_hub ][2],
				'isPartOf'    => array( '@id' => $home . '#website' ),
			);
			global $wpdb;
			$ntbl = $wpdb->prefix . 'aq_notebooks';
			if ( (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $ntbl ) ) === $ntbl ) {
				if ( 'works' === $aq_mkt_hub ) {
					$srows = $wpdb->get_results( "SELECT id, slug, kind, title, abstract, thumb, doi, published_at, author_id FROM {$ntbl} WHERE status = 'published' ORDER BY id DESC LIMIT 24" );
				} else {
					$srows = $wpdb->get_results( $wpdb->prepare(
						"SELECT id, slug, kind, title, abstract, thumb, doi, published_at, author_id FROM {$ntbl} WHERE status = 'published' AND kind = %s ORDER BY id DESC LIMIT 24",
						aq_feed_kind_for( $aq_mkt_hub )
					) );
				}
				$sitems = array();
				foreach ( (array) $srows as $sr ) {
					if ( empty( $sr->title ) ) {
						continue;
					}
					$su = aq_notebook_url( $sr );
					$sitems[] = array(
						'@type'    => 'ListItem',
						'position' => count( $sitems ) + 1,
						'url'      => $su,
						'item'     => array( '@type' => aq_seo_notebook( $sr )['@type'], 'name' => (string) $sr->title, 'url' => $su ),
					);
				}
				if ( $sitems ) {
					$page['mainEntity'] = array( '@type' => 'ItemList', 'numberOfItems' => count( $sitems ), 'itemListElement' => $sitems );
				}
			}
			$nodes[] = $page;
		}

		// ── One published notebook (/nb/<id>/(<slug>/)) → its per-kind typed node ──
		if ( function_exists( 'aq_app_current_notebook' ) ) {
			$aq_nb = aq_app_current_notebook();
			if ( $aq_nb ) {
				$nodes[] = aq_seo_notebook( $aq_nb );
			}
		}

		// ── Breadcrumbs on inner content (generic singular pages) ──
		// Skip the thread pages: they're real WP pages (is_singular true) but a richer,
		// content-aware breadcrumb is built for them below — emitting both would conflict.
		$lean_bc = function_exists( 'aq_app_current_thread' ) && aq_app_current_thread();
		if ( is_singular() && ! is_front_page() && ! $lean_bc ) {
			$bp = get_queried_object();
			if ( $bp instanceof WP_Post ) {
				// Localise the crumb label from the mesh cache (AQ_I18N_Store was retired; use the
				// active AQ\I18n cache via the theme's aq_seo_tr helper). No-op in English / when uncached.
				$bt = function_exists( 'aq_seo_tr' ) ? aq_seo_tr( get_the_title( $bp ) ) : get_the_title( $bp );
				$nodes[] = array(
					'@type'           => 'BreadcrumbList',
					'itemListElement' => array(
						array( '@type' => 'ListItem', 'position' => 1, 'name' => 'ArtaQuest', 'item' => $home ),
						array( '@type' => 'ListItem', 'position' => 2, 'name' => $bt, 'item' => get_permalink( $bp ) ),
					),
				);
			}
		}

		// ── Breadcrumbs for the lean app routes (notebook / thread / profile) ──
		// The is_singular() block above can't fire on these — they're is_404() in WP's eyes — so our
		// most important pages had no BreadcrumbList. Build the trail from the resolved soft content:
		// a notebook threads Home → The Feed → its kind hub → the work itself.
		$crumbs = null;
		if ( function_exists( 'aq_app_current_notebook' ) && ( $bn = aq_app_current_notebook() ) ) {
			$bhub   = aq_feed_hub_for_kind( (string) $bn->kind );
			$bhubs  = aq_feed_hubs();
			$crumbs = array(
				array( 'ArtaQuest', $home ),
				array( 'The Feed', $home . 'works/' ),
			);
			if ( isset( $bhubs[ $bhub ] ) ) {
				$crumbs[] = array( $bhubs[ $bhub ][0], $home . $bhub . '/' );
			}
			$crumbs[] = array( (string) $bn->title, aq_notebook_url( $bn ) );
		} elseif ( function_exists( 'aq_app_current_thread' ) && ( $bt2 = aq_app_current_thread() ) ) {
			$crumbs = array(
				array( 'ArtaQuest', $home ),
				array( 'Discussions', $home . 'discussions/' ),
				array( $bt2->title, $home . 'discussions/?forum=' . rawurlencode( $bt2->topic ? $bt2->topic : 'general' ) . '&thread=' . (int) $bt2->id ),
			);
		} else {
			$bps = get_query_var( 'aq_profile' );
			if ( $bps ) {
				$bu = get_user_by( 'slug', sanitize_title( $bps ) );
				if ( ! $bu ) { $bu = get_user_by( 'login', sanitize_title( $bps ) ); }
				if ( $bu ) {
					$crumbs = array(
						array( 'ArtaQuest', $home ),
						array( $bu->display_name, home_url( '/u/' . $bu->user_nicename . '/' ) ),
					);
				}
			}
		}
		if ( $crumbs ) {
			$items = array();
			foreach ( $crumbs as $i => $c ) {
				$items[] = array( '@type' => 'ListItem', 'position' => $i + 1, 'name' => $c[0], 'item' => $c[1] );
			}
			$nodes[] = array( '@type' => 'BreadcrumbList', 'itemListElement' => $items );
		}

		$graph = array( '@context' => 'https://schema.org', '@graph' => $nodes );
		// JSON_HEX_TAG escapes < and > to < / > so no string field (course/comment/topic name,
		// citation title, blurb, …) can break out of this inline <script> with a literal </script>.
		echo "\n<script type=\"application/ld+json\">" . wp_json_encode( $graph, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG ) . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	},
	5
);
