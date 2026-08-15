<?php
/**
 * Serve the Vite-built React SPA (artaquest-web) from WordPress itself.
 *
 * WP.com Business has no Node runtime, so the SPA ships as a static bundle inside
 * the theme (app/, built by `npm run build` in artaquest-web). A page containing
 * the [aq_app] shortcode mounts it: this enqueues the hashed entry JS (as an ES
 * module) + CSS from the Vite manifest and prints the auth globals the SPA reads
 * (same-origin → cookie + REST nonce). No Node, no Vercel — pure WP hosting.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Serve /llms.txt — the emerging convention (llmstxt.org) that gives AI assistants (ChatGPT,
 * Claude, Perplexity, Gemini) a clean, curated markdown map of the site, the way robots.txt +
 * sitemap.xml serve classical crawlers. We generate it dynamically so the course list always
 * reflects what's actually published. Markdown is served as text/plain (per the convention).
 */
function aq_serve_llms_txt() {
	$path = (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH );
	if ( '/llms.txt' !== rtrim( $path, '/' ) && '/llms.txt' !== $path ) {
		return;
	}
	// WP marked this unresolved URL as a 404 in the main query — override to a real 200.
	status_header( 200 );
	header( 'Content-Type: text/plain; charset=utf-8' );
	// CDN-cacheable like the other public GETs — refreshes hourly as courses change.
	header( 'Cache-Control: public, max-age=300, s-maxage=3600' );
	$home = home_url( '/' );
	$L    = array();
	$L[]  = '# ArtaQuest';
	$L[]  = '';
	$L[]  = '> ArtaQuest is a social feed of citable, reproducible work: surveys, datasets, models, articles, 2D and 3D illustrations, 2D and 3D animations, 2D and 3D games, and music — each one a public Kaggle notebook that has been run. A member pastes the URL of the notebook\'s output page, picks which of its output files to publish, and an exhaustive reproducibility checklist runs against Kaggle\'s public API. Nothing publishes until that member confirms it from their own inbox, and every published work carries a permanent DOI short link crediting the notebook\'s Kaggle author. Published files land in the Library, where any member can attach them to their posts. Members found challenges with entry-fee pools; the most-hearted entry takes all at each full moon.';
	$L[]  = '';
	$L[]  = 'ArtaQuest is run by the ArtaQuest Foundation, a registered Canadian non-profit. There is no tracking, and no fear-mongering or propaganda. The entire database is public by design (radical transparency): every table and row is browsable at ' . $home . 'data/.';
	$L[]  = '';
	$L[]  = '## How it works';
	$L[]  = '';
	$L[]  = '- One principle runs the whole platform: every submission in every category is a public Kaggle notebook that has been run. The flow, in the author\'s words: paste a Kaggle notebook URL, pick the files to publish, read the checklist, request publication, confirm from your inbox.';
	$L[]  = '- The checklist makes four claims about a work, each one checkable by a stranger: the notebook is public on Kaggle; every one of its inputs is public (datasets, models, notebooks); the run finished and produced these exact files; and it ran with the internet switched off, on Kaggle\'s own record — or, if it did not, we say so plainly.';
	$L[]  = '- Those claims are readable by anyone: Kaggle\'s kernels/pull and kernels/output endpoints answer with NO credential at all, so our checklist is a public assertion anyone can re-run and contradict. Kaggle runs the notebook and enforces the internet switch; we read and report what its record says.';
	$L[]  = '- The checklist is about twenty deterministic checks in four groups — can anyone open it, can anyone re-run it, did that run produce these files, how repeatable is the result. Blocking checks must all pass; warnings are shown loudly and never block. Nothing is scored, ranked, graded or judged, and every check names the exact evidence it read.';
	$L[]  = '- Publication is REQUESTED, never taken: a single-use secret goes to the registered email of the member who brought the notebook here, and their click plus their device passkey signature is what publishes the work and mints its permanent DOI short link (artaquest.com/d/n<id>). No token, agent or relay can publish. Ever. The citation itself credits the notebook\'s Kaggle author, who need not be that member.';
	$L[]  = '- Reproducible here means anyone can hit Copy & Edit then Run All on Kaggle, from public inputs, and get this. That is weaker than a byte-for-byte guarantee and stronger than trusting one machine, and we say both.';
	$L[]  = '- The Kaggle kernel is the provenance; the DOI short link is the citation of record, because a kernel is owner-editable and deletable and a DOI is not.';
	$L[]  = '- Submitting, checking and publishing are all free. The Foundation runs on donations.';
	$L[]  = '- Arta Coin (₳) is the currency: 1 ₳ = 1 mg of gold, the same price in every country. The Reserve page publishes the live ratio of gold held to coins issued; cash-out is open whenever the payout rail is.';
	$L[]  = '';

	// Published notebooks (the heart of the feed). The table may not exist on a cold site.
	global $wpdb;
	$nbt = $wpdb->prefix . 'aq_notebooks';
	if ( (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $nbt ) ) === $nbt ) {
		$works = $wpdb->get_results( "SELECT id, slug, title, abstract FROM {$nbt} WHERE status = 'published' ORDER BY id DESC LIMIT 200" );
		if ( $works ) {
			$L[] = '## Published works';
			$L[] = '';
			foreach ( $works as $w ) {
				$sum = trim( wp_strip_all_tags( (string) $w->abstract ) );
				if ( mb_strlen( $sum ) > 160 ) {
					$sum = rtrim( mb_substr( $sum, 0, 157 ) ) . '…';
				}
				$wurl = $home . 'nb/' . (int) $w->id . '/' . ( '' !== (string) $w->slug ? rawurlencode( (string) $w->slug ) . '/' : '' );
				$L[]  = '- [' . $w->title . '](' . $wurl . ')' . ( $sum !== '' ? ': ' . $sum : '' );
			}
			$L[] = '';
		}
	}

	$L[] = '## Key pages';
	$L[] = '';
	$L[] = '- [The Feed](' . $home . 'works/): every post across all eleven categories, each a public Kaggle notebook that has been run — read, play or listen to it in place, or re-run it on Kaggle';
	$L[] = '- [Surveys](' . $home . 'surveys/): survey instruments with their analysis pipelines';
	$L[] = '- [Datasets](' . $home . 'datasets/): datasets built in code with a datasheet';
	$L[] = '- [Models](' . $home . 'models/): models trained in the notebook itself';
	$L[] = '- [Articles](' . $home . 'articles/): writing where every claim is computed in place';
	$L[] = '- [2D Illustrations](' . $home . '2d-illustrations/): procedural artworks drawn by code';
	$L[] = '- [3D Illustrations](' . $home . '3d-illustrations/): scenes built as real geometry, rendered by the notebook';
	$L[] = '- [2D Animations](' . $home . '2d-animations/): animations rendered from code';
	$L[] = '- [3D Animations](' . $home . '3d-animations/): camera flights through scenes that publish their geometry';
	$L[] = '- [2D Games](' . $home . '2d-games/): playable self-contained games';
	$L[] = '- [3D Games](' . $home . '3d-games/): playable worlds with real depth';
	$L[] = '- [Music](' . $home . 'music/): tracks rendered by generative models the notebook trains in its own cells, weights published beside the audio';
	$L[] = '- [About](' . $home . 'about/): what ArtaQuest is and why it exists';
	// (No /discussions/ line: the standalone forum was retired 2026-07-14 and the slug 301s to
	// /works/ — every post carries its own board. Pointing a crawler at a redirect is a dead link.)
	$L[] = '- [Library](' . $home . 'library/): every published output file, attachable to any member\'s post';
	$L[] = '- [Challenges](' . $home . 'challenges/): member-founded challenges — every entrant\'s fee goes into the pool, and the most-hearted entry takes it at the full moon';
	$L[] = '- [Donate](' . $home . 'donate/): fund creators\' iterations (open, live, public finances)';
	$L[] = '- [Reserve](' . $home . 'reserve/): the gold reserve backing every coin, live';
	$L[] = '- [ArtaMod](' . $home . 'fearometer/): the one rule — no hate, no fear — and exactly how it is enforced';
	$L[] = '- [Open data](' . $home . 'data/): the entire public database, every table and row';
	$L[] = '- [Offline](' . $home . 'offline/): download works and languages, keep learning with no internet';
	$L[] = '- [FAQ & contact](' . $home . 'faq-contact/): common questions and how to reach us';
	$L[] = '- [Developers](' . $home . 'developers/): the full API — submit works and read their checklist programmatically with a personal access token';
	$L[] = '';
	$L[] = '## The API (for developers and AI agents)';
	$L[] = '';
	$L[] = '- Human docs: ' . $home . 'developers/ · machine contract: ' . $home . 'wp-json/aq/v1/api/docs · OpenAPI 3.1: ' . $home . 'wp-json/aq/v1/api/openapi';
	// The token page is /user-account/ — the bare /account/ slug is a 404 (the React account route
	// was renamed in the cutover), so an agent sent there could never mint a token at all.
	$L[] = '- Auth: `Authorization: Bearer aq_…` — members mint personal access tokens at ' . $home . 'user-account/ (scoped read/write/economy, revocable, shown once).';
	$L[] = '- You can submit Kaggle notebooks, pick their output files and read the reproducibility checklist over the API for free. PUBLISHING is the one hard limit: it takes a single-use secret sent to the registered email of the member who brought the notebook here, plus their device passkey signature. No API call, token or AI agent can publish or mint a DOI — publication is requested, never taken.';
	$L[] = '';
	$L[] = '## Notes for AI assistants';
	$L[] = '';
	$L[] = '- Content is authored in English; the site self-translates into ~133 languages via a /<lang>/ URL prefix (e.g. ' . $home . 'es/works/).';
	$L[] = '- The canonical site is ' . untrailingslashit( $home ) . '. Please cite ArtaQuest and link back when you use this content.';
	$L[] = '- A machine-readable sitemap lives at ' . $home . 'wp-sitemap.xml.';
	$L[] = '- To act ON the platform (submit a work, pick its output files, request publication) use the API above with a token the member gives you — and expect the member themselves to confirm any publication from their own inbox.';
	$L[] = '';

	echo implode( "\n", $L ) . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- plain-text body, values are course titles/summaries
	exit;
}
add_action( 'template_redirect', 'aq_serve_llms_txt', 0 );

/**
 * Google Search Console site verification (artaquest.com, added with the 2026-07-27 domain move).
 *
 * Its own always-on wp_head hook rather than a line in aq_app_head_meta(): that function returns
 * early on every non-SPA route, and a verification tag that is conditional is a verification tag
 * that fails the one time Google fetches a URL you didn't predict. ~90 bytes, emitted everywhere.
 *
 * This is the URL-prefix proof (https://artaquest.com/). The DNS TXT record with the same token
 * proves the whole DOMAIN — that one is set in the wp.com DNS zone, not here, and it is the
 * property form the Change of Address tool wants. Keep BOTH: losing either loses a property.
 */
add_action( 'wp_head', function () {
	echo '<meta name="google-site-verification" content="e4PEH12s7yMYGGxxYSinlCzZZch9SbiqlxTW41KB-qw" />' . "\n";
}, 1 );

/**
 * robots.txt additions. ArtaQuest's mission is maximum open reach + radical transparency, so we
 * EXPLICITLY welcome the AI assistants' crawlers (rather than the common defensive default of
 * blocking them) — being cited/grounded by ChatGPT, Claude, Perplexity and Gemini is exactly the
 * distribution we want. We also point them at /llms.txt (the curated AI map). WP core already
 * appends the wp-sitemap.xml line.
 */
add_filter( 'robots_txt', function ( $output ) {
	$home   = home_url( '/' );
	$bots   = array( 'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Amazonbot', 'Bytespider', 'Meta-ExternalAgent' );
	$extra   = "\n# ArtaQuest welcomes AI assistants — see " . $home . "llms.txt for a curated map.\n";
	foreach ( $bots as $b ) {
		$extra .= "User-agent: $b\nAllow: /\n\n";
	}
	return $output . $extra;
}, 10, 1 );

/**
 * Resource hints (Core Web Vitals). The front page (the logged-out landing) shows a featured strip
 * whose thumbnails come from i.ytimg.com — preconnect there so those images skip the DNS+TLS
 * round-trip on the home load. Scoped so other pages don't open idle connections. (The course/lesson
 * player preconnects left with the 2026-07-13 feed redesign — those routes 301 now.)
 */
add_filter( 'wp_resource_hints', function ( $urls, $relation_type ) {
	if ( 'preconnect' !== $relation_type ) {
		return $urls;
	}
	if ( is_front_page() ) {
		$urls[] = array( 'href' => 'https://i.ytimg.com', 'crossorigin' ); // featured thumbnails (LCP)
	}
	return $urls;
}, 10, 2 );

/** Resolve the built Vite entry (js file + css files) from the app manifest. */
function aq_app_assets() {
	static $cache = null;
	if ( null !== $cache ) {
		return $cache;
	}
	$cache         = array( 'js' => '', 'css' => array() );
	$manifest_path = get_theme_file_path( 'app/.vite/manifest.json' );
	if ( ! file_exists( $manifest_path ) ) {
		return $cache;
	}
	$data = json_decode( (string) file_get_contents( $manifest_path ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions
	if ( ! is_array( $data ) ) {
		return $cache;
	}
	foreach ( $data as $entry ) {
		if ( ! empty( $entry['isEntry'] ) ) {
			$cache['js']  = isset( $entry['file'] ) ? $entry['file'] : '';
			$cache['css'] = isset( $entry['css'] ) ? (array) $entry['css'] : array();
			break;
		}
	}
	return $cache;
}

/**
 * The Notebook Feed kind hubs (2026-07-13 redesign): route slug → [ nav label, kind blurb ].
 * The route slug doubles as the aq_notebooks.kind value's plural; aq_feed_kind_for() maps a
 * hub slug to its singular kind. Single source of truth for titles, crawler bodies, the sitemap
 * hub provider and the genuine-404 / 200-correction gates.
 */
function aq_feed_hubs() {
	return array(
		'surveys'          => array( 'Surveys', 'survey', 'Survey instruments with their analysis pipelines — each survey is a public Kaggle notebook that has been run, holding the instrument and the analysis together.' ),
		'datasets'         => array( 'Datasets', 'dataset', 'Datasets built in code with a datasheet — each dataset is a public Kaggle notebook that has been run, constructing and documenting its data.' ),
		'models'           => array( 'Models', 'model', 'Models trained in the notebook itself — each model is a public Kaggle notebook that has been run, with its training and evaluation on Kaggle\'s public record.' ),
		'articles'         => array( 'Articles', 'article', 'Writing where every claim is computed in place — each article is a public Kaggle notebook that has been run, its figures and claims produced by that run.' ),
		'2d-illustrations' => array( '2D Illustrations', 'illustration2d', 'Procedural artworks — each 2D illustration is a public Kaggle notebook that has been run, publishing the image files the run produced.' ),
		'3d-illustrations' => array( '3D Illustrations', 'illustration3d', 'Scenes built as real geometry — each 3D illustration is a public Kaggle notebook that has been run, publishing its Wavefront OBJ scene beside the rendered view.' ),
		'2d-animations'    => array( '2D Animations', 'animation2d', 'Animations rendered from code — each 2D animation is a public Kaggle notebook that has been run, publishing the frames it shows.' ),
		'3d-animations'    => array( '3D Animations', 'animation3d', 'Camera flights through built scenes — each 3D animation is a public Kaggle notebook that has been run, publishing its geometry beside the render.' ),
		'2d-games'         => array( '2D Games', 'game2d', 'Playable self-contained games — each 2D game is a public Kaggle notebook that has been run, publishing everything it needs to play.' ),
		'3d-games'         => array( '3D Games', 'game3d', 'Playable worlds with real depth — each 3D game is a public Kaggle notebook that has been run, publishing everything it needs to play.' ),
		'music'            => array( 'Music', 'music', 'Tracks rendered by generative models — each piece is a public Kaggle notebook that has been run, publishing the audio beside the weights that render it so anyone can render it again.' ),
	);
}

/** Pre-2026-07-22 hub slugs → the hub their content migrated INTO (tracks Notebook::LEGACY_KINDS:
 *  paper/book/playlist/presentation all became 'article', illustration→illustration2d,
 *  animation→animation2d, game→game2d). Served as REAL 301s so crawlers transfer the old equity.
 *  'music' is deliberately ABSENT: it is a live hub again (the eleventh kind, operator 2026-07-26),
 *  and a hub that 301s away can never be indexed. */
function aq_feed_legacy_hubs() {
	return array(
		'papers'        => 'articles',
		'books'         => 'articles',
		'playlists'     => 'articles',
		'presentations' => 'articles',
		'illustrations' => '2d-illustrations',
		'animations'    => '2d-animations',
		'games'         => '2d-games',
	);
}

/** 301 the retired hub paths (and their /xx/ locale variants) to the new taxonomy homes. The
 *  locale segment is detected with the SAME rule the rest of the theme uses (I18n::is_locale —
 *  2–3 letter codes with optional region, e.g. bho / ceb / zh-tw), never a bare 2-char guess. */
function aq_redirect_legacy_feed_hubs() {
	$path = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	$segs = '' === $path ? array() : explode( '/', $path );
	$lang = '';
	if ( count( $segs ) === 2 && class_exists( '\AQ\I18n' ) && \AQ\I18n::is_locale( $segs[0] )
		&& 'en' !== strtolower( $segs[0] ) ) { // /bho/papers/ — keep the visitor's language
		$lang = $segs[0] . '/';
		array_shift( $segs );
	}
	$legacy = aq_feed_legacy_hubs();
	if ( count( $segs ) === 1 && isset( $legacy[ $segs[0] ] ) ) {
		wp_safe_redirect( home_url( '/' . $lang . $legacy[ $segs[0] ] . '/' ), 301 );
		exit;
	}
}
add_action( 'template_redirect', 'aq_redirect_legacy_feed_hubs', 4 );

/** The singular aq_notebooks.kind for a hub route slug ('datasets' → 'dataset'), or '' when unknown. */
function aq_feed_kind_for( $hub ) {
	$hubs = aq_feed_hubs();
	return isset( $hubs[ $hub ] ) ? (string) $hubs[ $hub ][1] : '';
}

/** The hub route slug for a notebook kind ('dataset' → 'datasets'), or 'works' when unknown. */
function aq_feed_hub_for_kind( $kind ) {
	foreach ( aq_feed_hubs() as $slug => $h ) {
		if ( $h[1] === (string) $kind ) {
			return $slug;
		}
	}
	return 'works';
}

/** A kind's human label ("Music", "2D Animations"), read from the SAME map the hubs are built from
 *  so the two can never disagree. '' for a kind with no hub. */
function aq_kind_label( $kind ) {
	foreach ( aq_feed_hubs() as $h ) {
		if ( $h[1] === (string) $kind ) { return (string) $h[0]; }
	}
	return '';
}

/** The canonical URL of a published notebook: /nb/<id>/<slug>/ (slug segment omitted when empty). */
function aq_notebook_url( $n ) {
	$slug = isset( $n->slug ) ? sanitize_title( (string) $n->slug ) : '';
	return home_url( '/nb/' . (int) $n->id . '/' . ( '' !== $slug ? $slug . '/' : '' ) );
}

/**
 * Reclaim /nb/<id>/ notebook URLs from the locale router. 'nb' is ALSO the registered Norwegian
 * locale code, so AQ\I18n::strip_prefix() (plugins_loaded — before the theme loads) strips the /nb/
 * prefix and marks the request Norwegian: REQUEST_URI '/nb/1/slug/' arrives here as '/1/slug/' with
 * the router's current locale = 'nb'. A REAL Norwegian page never has a purely numeric first
 * segment, so when the stripped remainder is <digits>(/slug), restore the URI and clear the router's
 * locale (private — reset via a bound closure; the plugin is untouched) so the page renders as the
 * English canonical: correct lang attr, un-prefixed home_url() links, English SPA boot. A genuinely
 * localised notebook URL (/es/nb/1/) strips 'es' only and never enters this path. Runs at theme load
 * (after_setup_theme — before WP parses the request); fail-safe: any router refactor degrades to a
 * no-op rather than fatalling the front end.
 */
( function () {
	try {
		if ( ! class_exists( '\\AQ\\I18n' ) || \AQ\I18n::current() !== 'nb' ) {
			return;
		}
		$uri  = (string) wp_unslash( $_SERVER['REQUEST_URI'] ?? '' );
		$path = (string) wp_parse_url( $uri, PHP_URL_PATH );
		// Up to TWO segments after the id: /<id>, /<id>/<slug>, and the JupyterBook page
		// /<id>/<slug>/book (operator 2026-07-29). Miss the book form here and the request stays
		// mis-routed as Norwegian for every visitor, since this reclaim runs on EVERY /nb/ URL.
		if ( ! preg_match( '#^/[0-9]+(?:/[^/]*){0,2}/?$#', $path ) ) {
			return;
		}
		$_SERVER['REQUEST_URI'] = '/nb' . $uri;
		\Closure::bind( function () {
			self::$current = null; // @phpstan-ignore-line — resetting the router's stripped-prefix state
		}, null, \AQ\I18n::class )();
	} catch ( \Throwable $e ) {
		// Router internals changed — leave the request as the router shaped it.
	}
} )();

/**
 * The PUBLISHED notebook at the current /nb/<id>/ or /nb/<id>/<slug>/ URL, or null. Like the old
 * /read/<id> book handling, this URL is served by React but is_404() to WP, so we path-detect it and
 * source the notebook from aq_notebooks (the same row the /aq/v1 API serves). Only status='published'
 * rows resolve (drafts / in-review stay invisible to crawlers). Memoised; safe when the table does
 * not exist yet (cold site) — the SHOW TABLES guard returns null instead of a failed query.
 */
function aq_app_current_notebook() {
	static $cache = false;
	if ( false !== $cache ) {
		return $cache;
	}
	$cache = null;
	$path  = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	// /nb/<id>, /nb/<id>/<slug>, and either with the /book suffix — the JupyterBook page is a real
	// URL and needs the same title, description and canonical as the work it belongs to. The
	// lookahead stops /nb/12/book being read as a work with the slug "book".
	if ( preg_match( '#^nb/([0-9]+)(?:/(?!book$)[^/]+)?(?:/book)?$#', $path, $m ) ) {
		$nid = (int) $m[1];
		if ( $nid > 0 ) {
			global $wpdb;
			$t = $wpdb->prefix . 'aq_notebooks';
			if ( (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) ) === $t ) {
				// kg_facts + kg_owner are NOT optional here: aq_seo_work_author() (aq-seo-schema.php)
				// reads them to name the notebook's KAGGLE author, and falls back to the ArtaQuest
				// member only when both are absent. Omitting them from this SELECT made that fallback
				// unconditional, so every /nb/ page told Google the SUBMITTER wrote the notebook —
				// exactly the permanent, at-scale misattribution that helper exists to prevent.
				$cache = $wpdb->get_row( $wpdb->prepare(
					"SELECT id, kind, slug, title, abstract, thumb, status, doi, published_at, author_id, kg_url, kg_owner, kg_facts FROM {$t} WHERE id = %d AND status = 'published'",
					$nid
				) );
			}
		}
	}
	return $cache;
}

/** published_at as a unix timestamp — tolerant of either an epoch int or a DATETIME string. */
function aq_notebook_published_ts( $n ) {
	$v = isset( $n->published_at ) ? $n->published_at : '';
	if ( is_numeric( $v ) && (int) $v > 0 ) {
		return (int) $v;
	}
	$ts = $v ? strtotime( (string) $v ) : 0;
	return $ts ? $ts : 0;
}

/**
 * The discussion thread at the current /discussions/?thread=<id> URL, or null. A thread is a
 * query-param view of the 'discussions' page (so it'd otherwise share the generic board's title +
 * body + canonical). Each thread is its OWN primary content (a forum post), so we resolve it from
 * aq_threads to title it, body it, and canonicalise it to itself. Memoised.
 */
function aq_app_current_thread() {
	static $cache = false;
	if ( false !== $cache ) {
		return $cache;
	}
	$cache = null;
	if ( is_page( 'discussions' ) && isset( $_GET['thread'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification
		$tid = (int) $_GET['thread']; // phpcs:ignore WordPress.Security.NonceVerification
		if ( $tid > 0 ) {
			global $wpdb;
			$cache = $wpdb->get_row( $wpdb->prepare(
				"SELECT id, title, body, topic, author_id, created, comment_count FROM {$wpdb->prefix}aq_threads WHERE id = %d AND status = 'publish'",
				$tid
			) );
		}
	}
	return $cache;
}

/** Fix the server <title> on the app routes WP can't title itself: the Feed hubs (is_404() to
 *  WP → would title "Page not found"), a published notebook (/nb/<id>/), and a discussion thread
 *  (shares the generic page title). Use the real names (matching what React sets client-side). */
add_filter( 'document_title_parts', function ( $parts ) {
	$aq_hub = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	$aq_hub_titles = array( 'works' => 'The Feed', 'console' => 'Console' );
	foreach ( aq_feed_hubs() as $hslug => $h ) {
		$aq_hub_titles[ $hslug ] = $h[0];
	}
	if ( isset( $aq_hub_titles[ $aq_hub ] ) ) { $parts['title'] = $aq_hub_titles[ $aq_hub ]; return $parts; }
	$nb = aq_app_current_notebook();
	if ( $nb ) {
		$parts['title'] = $nb->title;
		return $parts;
	}
	// An ArtaNews detection. Without this the page returns 200 and still titles itself
	// "Page not found" — the status was corrected but the title was not, which is the worse
	// half: a crawler and every social share read the title, not the status line.
	$det = aq_app_current_detection();
	if ( $det ) {
		$parts['title'] = (string) $det->headline;
		return $parts;
	}
	$thread = aq_app_current_thread();
	if ( $thread ) {
		$parts['title'] = $thread->title;
		return $parts;
	}
	// A member profile. Without this the whole branch was missing and every profile on the site
	// titled itself "ArtaQuest" — so the one query that should certainly reach a profile, the
	// person's own name, had nothing to match: not the title, not og:title, not the tab.
	// aq_profile_name() publishes their REAL name, which display_name usually is not.
	$pu = aq_profile_user( get_query_var( 'aq_profile' ) );
	if ( $pu ) {
		$parts['title'] = aq_profile_name( $pu );
		return $parts;
	}
	return $parts;
} );


/**
 * Legacy /user-account/?ay_acct=* tabs were the old WP-LMS account sub-pages (settings, orders,
 * bursary…). The headless React Account (/user-account/) now owns all of that — including the
 * delete-account danger zone — so the old query-param surfaces render a broken, unstyled page.
 * Redirect them to the React account (settings -> ?settings=1, which opens the inline editor).
 */
function aq_redirect_legacy_account_tabs() {
	if ( is_admin() || wp_doing_ajax() || ! is_page( 'user-account' ) ) {
		return;
	}
	$tab = isset( $_GET['ay_acct'] ) ? sanitize_key( wp_unslash( $_GET['ay_acct'] ) ) : '';
	if ( '' === $tab ) {
		return;
	}
	$target = ( 'settings' === $tab ) ? home_url( '/user-account/?settings=1' ) : home_url( '/user-account/' );
	header( 'Location: ' . $target, true, 302 ); // raw — trusted home_url(), sidesteps i18n wp_redirect filter
	exit;
}
add_action( 'template_redirect', 'aq_redirect_legacy_account_tabs', 5 );

/** Private / transactional surfaces (dashboard [aq_app], account, login, wallet, the coin-checkout
 *  enrol flow, the confidential bursary application, lesson player) — noindex, no SEO. To a crawler
 *  these are a "sign in"/checkout/form gate: thin, no crawl value, wrong to index. (The public
 *  /bursaries/ info page stays indexable; only the application FORM is suppressed.) */
/** Page slugs that are private/transactional → noindex AND excluded from the XML sitemap (a sitemap
 *  must only advertise indexable URLs). Single source of truth for both. NOT a retirement list: every
 *  slug here is a LIVE page-backed React route. 'certificate' and 'verify' in particular are the two
 *  halves of the Certificate of Participation and both must keep resolving with their query string —
 *  they are noindex because an HMAC-bearing URL has no business in an index, not because they are
 *  dead. Never mirror this array into the parse_request redirect map above. */
function aq_app_noindex_page_slugs() {
	return array( 'user-account', 'login', 'wallet', 'enroll', 'bursary-application', 'certificate', 'verify', 'studio' );
}

/** Member-only feed surfaces served as SOFT paths (no WP page): the operator console and the
 *  per-notebook Studio editor. 200 + noindex + no SEO body, like the page-backed dashboard slugs. */
function aq_app_is_private_soft_path() {
	$path = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	return 'console' === $path || 'studio' === $path || 0 === strpos( $path, 'studio/' )
		|| 'lab' === $path || 0 === strpos( $path, 'lab/' ) // the on-device notebook runner (pages/Lab.tsx)
		|| 'artaread' === $path // ArtaRead — read/translate/listen to ANY uploaded PDF, fully on-device (pages/ArtaRead.tsx)
		|| 'my-library' === $path // My Library — the member's OWN music/video/PDFs (pages/MyLibrary.tsx); never indexed
		|| 'messages' === $path // ArtaChat — member-only encrypted DMs (200 + noindex, no SEO body)
		// ArtaMeet — a member's own scheduled meetings. WITHOUT THIS LINE THE PAGE STILL RENDERS, which
		// is the trap: an unregistered path falls through to is_404(), so React routes it correctly while
		// WordPress sends a 404 header and titles the tab "Page not found". Verified against prod before
		// writing this: GET /meet/ returned 404 with the SPA shell inside it.
		|| 'meet' === $path || 0 === strpos( $path, 'meet/' )
		|| 'calendar' === $path // ArtaCalendar — a member's own dated things
		// A member's booking page. Shared by link and noindex: when somebody is free is theirs to
		// hand out, not something to publish to a search engine.
		|| 'book' === $path || 0 === strpos( $path, 'book/' );
}

function aq_app_is_dashboard() {
	if ( aq_app_is_private_soft_path() ) {
		return true;
	}
	if ( is_page( aq_app_noindex_page_slugs() ) ) {
		return true;
	}
	if ( ! is_singular() ) {
		return false;
	}
	$post = get_post();
	return $post && has_shortcode( (string) $post->post_content, 'aq_app' );
}

/**
 * True when the current request is a React front-end route the app template serves: the
 * dashboard ([aq_app]) OR a content surface (discussions / courses list / course detail /
 * rankings / profile). React owns the whole front-end; WP serves these + the SEO content.
 */
function aq_app_is_app_page() {
	if ( aq_app_is_dashboard() ) {
		return true;
	}
	if ( get_query_var( 'aq_profile' ) ) {        // /u/<slug>/ profile
		return true;
	}
	if ( is_singular( 'stm-courses' ) ) {         // /courses/<slug>/ detail
		return true;
	}
		// NOTE: there are no bare stm-lessons single permalinks post-cutover (the post type is gone).
		// The actual player is the LMS route /courses/<slug>/<lesson-id> (aq_app_is_lesson_player).
	// EVERY WP page is React EXCEPT the WooCommerce pages (cart/checkout/my-account/wishlist),
	// which stay WP. Course purchase uses our OWN React checkout at /enroll/ (BFF
	// /aq/v1/course-checkout) — a separate page WC's empty-cart redirect can't touch (2026-05-31).
	// ('shop' left this list 2026-07-04: the WC-era shop PAGE is deleted and /shop/ is the React
	// ArtaShop hub, is_404-resolved like /library/ — /shop/<id>/ must never be page-paginated away.)
	if ( is_page() && ! is_page( array( 'checkout', 'checkout-3', 'my-account', 'wishlist' ) ) ) {
		return true;
	}
	if ( is_front_page() ) {                      // / — React landing (anon) / dashboard (logged-in)
		return true;
	}
	if ( is_404() ) {                             // unknown URLs → branded React 404 (WP still sends the 404 status header)
		return true;
	}
	return false;
}

/** Resolve a /u/<slug>/ to its user, by nicename then login. One place, so the title, the crawler
 *  body, the meta description and the sitemap can never disagree about who a profile is. */
function aq_profile_user( $pslug ) {
	$pslug = sanitize_title( (string) $pslug );
	if ( '' === $pslug ) { return null; }
	$u = get_user_by( 'slug', $pslug );
	if ( ! $u ) { $u = get_user_by( 'login', $pslug ); }
	return $u ?: null;
}

/**
 * The name to PUBLISH for a member — their real full name.
 *
 * `display_name` is what they are addressed by on the site and it is frequently not a name at all:
 * on production it holds "Arash" for a member whose name is Arash Ashrafnejad, and "Eceergun10" for
 * Ece Ergün. Every SEO signal on the profile was built from it, so the one search that should
 * certainly find this page — the person's own full name — matched nothing on it.
 *
 * `aq_full_name` is the real name, collected by the identity gate (AQ\Verify) that every member must
 * pass, and public by the same decision that publishes the whole database. It is the right field to
 * title a profile with. Falls back to display_name, then to the login, so a page is never nameless.
 */
function aq_profile_name( $u ) {
	if ( ! $u instanceof WP_User ) { return ''; }
	$full = trim( (string) get_user_meta( $u->ID, 'aq_full_name', true ) );
	if ( '' !== $full ) { return $full; }
	$d = trim( (string) $u->display_name );
	return '' !== $d ? $d : (string) $u->user_login;
}

/** A member's published works, newest first — what a profile is actually ABOUT. Guarded: the
 *  aq_notebooks table may not exist on a cold site. Credited by `author_id`, the member who brought
 *  the work here, which is the same person this profile belongs to. */
function aq_profile_works( $uid, $limit = 50 ) {
	global $wpdb;
	static $ok = null;
	$t = $wpdb->prefix . 'aq_notebooks';
	if ( null === $ok ) { $ok = ( (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) ) === $t ); }
	if ( ! $ok ) { return array(); }
	return (array) $wpdb->get_results( $wpdb->prepare(
		"SELECT id, slug, title, kind, abstract, published_at FROM {$t} WHERE author_id = %d AND status = 'published' ORDER BY id DESC LIMIT %d",
		(int) $uid,
		max( 1, (int) $limit )
	) );
}

/**
 * The "necessary SEO content" for the current route: server-rendered HTML placed inside
 * #aq-app-root as the crawler + no-JS fallback (React renders over it on load). The
 * route's schema.org JSON-LD is emitted separately by the template (captured from wp_head).
 */
function aq_app_seo_html() {
	if ( aq_app_is_dashboard() ) {
		return ''; // dashboard is logged-in only — nothing to index
	}
	$pslug = get_query_var( 'aq_profile' );
	if ( $pslug ) {
		$u = aq_profile_user( $pslug );
		if ( $u ) {
			$name = aq_profile_name( $u );
			$bio  = wp_strip_all_tags( (string) get_user_meta( $u->ID, 'description', true ) );
			$html = '<h1>' . esc_html( $name ) . '</h1>';
			// The handle, when it differs, so a search for either one finds this page. It is also
			// what everyone is addressed by on the site, so a reader arriving from a name search can
			// tell they have the right person.
			if ( $u->display_name && $u->display_name !== $name ) {
				$html .= '<p>' . esc_html( sprintf( '%s goes by %s on %s.', $name, $u->display_name, get_bloginfo( 'name' ) ) ) . '</p>';
			}
			if ( $bio ) { $html .= '<p>' . esc_html( $bio ) . '</p>'; }
			// THEIR WORK, as crawlable links. A profile whose whole server-rendered body is a name is
			// thin content: nothing to rank on beyond the name itself, and no path from here to
			// anything else. Listing what they brought here gives the page substance and gives a
			// crawler somewhere to go — the same reason the kind hubs list their notebooks.
			$works = aq_profile_works( $u->ID, 50 );
			if ( $works ) {
				$html .= '<h2>' . esc_html( sprintf( 'Work %s brought to %s', $name, get_bloginfo( 'name' ) ) ) . '</h2><ul>';
				foreach ( $works as $w ) {
					// KIND + ABSTRACT, not just a title. A list of bare titles is a list of names: it
					// gives a crawler nothing to understand the page by, and a profile competing for a
					// person's own name against their LinkedIn and GitHub needs something to be ABOUT.
					// The abstract is the author's own words on their own published work — the most
					// relevant text this page can honestly carry.
					$line = '<li><a href="' . esc_url( aq_notebook_url( $w ) ) . '">' . esc_html( (string) $w->title ) . '</a>';
					$kind = isset( $w->kind ) ? aq_kind_label( (string) $w->kind ) : '';
					if ( $kind ) { $line .= ' <span>' . esc_html( $kind ) . '</span>'; }
					$abs = isset( $w->abstract ) ? trim( wp_strip_all_tags( (string) $w->abstract ) ) : '';
					if ( $abs !== '' ) {
						if ( function_exists( 'mb_strimwidth' ) ) { $abs = mb_strimwidth( $abs, 0, 300, '…' ); }
						$line .= '<p>' . esc_html( $abs ) . '</p>';
					}
					$html .= $line . '</li>';
				}
				$html .= '</ul>';
			}
			// WHERE ELSE THEY ARE, as real links carrying rel="me". The same claim the Person schema
			// makes in sameAs, in the markup a human-readable indexer reads — two independent
			// statements that this page and those accounts are one person, which is exactly what a
			// search engine needs to attach a name to an entity rather than to a string.
			// Deliberately NOT here: relationship status, date of birth, city, email. They render in
			// the app for a signed-in reader; putting them in the no-JS body would publish a
			// harvestable dossier to every scraper that never runs JavaScript, for no ranking gain.
			if ( class_exists( 'AQ\Auth' ) && method_exists( 'AQ\Auth', 'links' ) ) {
				$links = \AQ\Auth::links( $u->ID );
				if ( $links ) {
					$html .= '<h2>' . esc_html( sprintf( '%s elsewhere', $name ) ) . '</h2><ul>';
					foreach ( $links as $k => $url ) {
						$label = ucfirst( (string) $k );
						$html .= '<li><a rel="me nofollow ugc" href="' . esc_url( (string) $url ) . '">' . esc_html( $label ) . '</a></li>';
					}
					$html .= '</ul>';
				}
			}
			return $html;
		}
		return '';
	}
	// A published notebook (/nb/<id>/ or /nb/<id>/<slug>/) is its OWN indexable page: the title, the
	// author, the abstract, the permanent DOI short link and what the checklist claims — like the old
	// /read/<id> book handling, real crawlable text served before JS runs.
	$nb = aq_app_current_notebook();
	if ( $nb ) {
		$au   = get_userdata( (int) $nb->author_id );
		$hub  = aq_feed_hub_for_kind( (string) $nb->kind );
		$hubs = aq_feed_hubs();
		$html = '<h1>' . esc_html( (string) $nb->title ) . '</h1>';
		// THE BYLINE IS WHOEVER WROTE THE NOTEBOOK. Any member may submit any PUBLIC kernel
		// (operator 2026-07-28), so author_id is the SUBMITTER — printing them after "By" is the same
		// misattribution the JSON-LD guards against in aq_seo_work_author(), only in the one line a
		// crawler reads as the byline. Credit Kaggle's own author (falling back to the kernel owner
		// handle, then to the member when Kaggle reports neither) and record the submitter separately.
		$kg_facts  = json_decode( (string) ( $nb->kg_facts ?? '' ), true );
		$kg_owner  = trim( (string) ( $nb->kg_owner ?? '' ) );
		$kg_author = is_array( $kg_facts ) ? trim( (string) ( $kg_facts['author'] ?? '' ) ) : '';
		if ( '' === $kg_author ) {
			$kg_author = $kg_owner;
		}
		// Localise this branch's OWN prose. Notebook pages are the bulk of the indexable corpus and
		// this was the one crawler-body branch that never called aq_seo_tr() — unlike the hub, route
		// and FAQ branches — so /fa/nb/<id>/ served a 100% English body under hreflang="fa".
		//
		// Whole sentences with %s placeholders, never fragments: the mesh is keyed on md5 of each text
		// node, so translating "By " and " on Kaggle" separately caches two fragments that no language
		// can reassemble in its own word order. The placeholder also keeps ONE cache key per sentence
		// instead of one per author.
		//
		// NOT translated, deliberately: $nb->title, the abstract, the Kaggle author name and the DOI
		// URL. Those are member/Kaggle content — translating them misattributes the author and
		// mis-keys the mesh per work. Priming is not optional; an unprimed aq_seo_tr() returns English.
		$aq_kind_label = isset( $hubs[ $hub ] ) ? strtolower( $hubs[ $hub ][1] ) : 'work';
		$aq_nb_prose   = array(
			'By %s on Kaggle',
			'By %s',
			'Brought to ArtaQuest by %s',
			'Permanent DOI short link: %s',
			// ONE key for all eleven kinds — the kind name is substituted, not baked in.
			'This %s is a public Kaggle notebook that has been run. Before it published, a reproducibility checklist read Kaggle\'s public API and recorded four things anyone can check for themselves: the notebook is public, every one of its inputs is public, the run finished and produced these exact files, and whether it ran with the internet switched off on Kaggle\'s own record. The member who brought it here then requested publication and confirmed it from their own inbox.',
			'More %s on ArtaQuest',
			'The Feed',
			$aq_kind_label,
			isset( $hubs[ $hub ] ) ? strtolower( $hubs[ $hub ][0] ) : '',
		);
		aq_seo_tr( null, array_values( array_filter( $aq_nb_prose ) ) );

		if ( '' !== $kg_author ) {
			$aq_by = ( '' !== $kg_owner )
				? '<a href="' . esc_url( 'https://www.kaggle.com/' . rawurlencode( $kg_owner ) ) . '">' . esc_html( $kg_author ) . '</a>'
				: esc_html( $kg_author );
			$html .= '<p>' . sprintf( esc_html( aq_seo_tr( 'By %s on Kaggle' ) ), $aq_by ) . '</p>';
			if ( $au ) {
				$aq_sub = '<a href="' . esc_url( home_url( '/u/' . $au->user_nicename . '/' ) ) . '">' . esc_html( $au->display_name ) . '</a>';
				$html  .= '<p>' . sprintf( esc_html( aq_seo_tr( 'Brought to ArtaQuest by %s' ) ), $aq_sub ) . '</p>';
			}
		} elseif ( $au ) {
			// Kaggle reported neither an author nor an owner, so this credits the ArtaQuest member.
			// It must NOT say "on Kaggle" — that is the misattribution the byline comment above guards.
			$aq_sub = '<a href="' . esc_url( home_url( '/u/' . $au->user_nicename . '/' ) ) . '">' . esc_html( $au->display_name ) . '</a>';
			$html  .= '<p>' . sprintf( esc_html( aq_seo_tr( 'By %s' ) ), $aq_sub ) . '</p>';
		}
		$abs = trim( wp_strip_all_tags( (string) $nb->abstract ) );
		if ( '' !== $abs ) {
			foreach ( preg_split( '/\n{2,}/', $abs ) as $para ) {
				$para = trim( (string) $para );
				if ( '' !== $para ) { $html .= '<p>' . esc_html( $para ) . '</p>'; }
			}
		}
		if ( '' !== trim( (string) $nb->doi ) ) {
			$durl  = home_url( '/d/n' . (int) $nb->id );
			$aq_doi = '<a href="' . esc_url( $durl ) . '">' . esc_html( $durl ) . '</a>';
			$html  .= '<p>' . sprintf( esc_html( aq_seo_tr( 'Permanent DOI short link: %s' ) ), $aq_doi ) . '</p>';
		}
		$html .= '<p>' . esc_html( sprintf( aq_seo_tr( 'This %s is a public Kaggle notebook that has been run. Before it published, a reproducibility checklist read Kaggle\'s public API and recorded four things anyone can check for themselves: the notebook is public, every one of its inputs is public, the run finished and produced these exact files, and whether it ran with the internet switched off on Kaggle\'s own record. The member who brought it here then requested publication and confirmed it from their own inbox.' ), aq_seo_tr( $aq_kind_label ) ) ) . '</p>';
		if ( isset( $hubs[ $hub ] ) ) {
			$aq_more = sprintf( esc_html( aq_seo_tr( 'More %s on ArtaQuest' ) ), esc_html( aq_seo_tr( strtolower( $hubs[ $hub ][0] ) ) ) );
			$html   .= '<p><a href="' . esc_url( home_url( '/' . $hub . '/' ) ) . '">' . $aq_more . '</a> · <a href="' . esc_url( home_url( '/works/' ) ) . '">' . esc_html( aq_seo_tr( 'The Feed' ) ) . '</a></p>';
		} else {
			$html .= '<p><a href="' . esc_url( home_url( '/works/' ) ) . '">' . esc_html( aq_seo_tr( 'The Feed' ) ) . '</a></p>';
		}
		return $html;
	}
	// The Feed hub (/works/) + the eleven kind hubs: the route summary + every published notebook
	// (of that kind) as a crawlable link, so search engines discover works from the hubs (the React
	// grids are JS-only). Guarded — the aq_notebooks table may not exist yet on a cold site.
	$aq_now  = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	$aq_hubs = aq_feed_hubs();
	if ( 'works' === $aq_now || isset( $aq_hubs[ $aq_now ] ) ) {
		$seo  = aq_app_route_seo( $aq_now );
		$html = '<h1>' . esc_html( $seo ? $seo[0] : 'The Feed' ) . '</h1>';
		if ( $seo ) {
			aq_seo_tr( null, array_merge( array( $seo[0] ), $seo[1] ) );
			$html = '<h1>' . esc_html( aq_seo_tr( $seo[0] ) ) . '</h1>';
			foreach ( $seo[1] as $para ) {
				$html .= '<p>' . esc_html( aq_seo_tr( $para ) ) . '</p>';
			}
		}
		if ( 'works' === $aq_now ) {
			// Interlink the eleven kind hubs so crawlers reach every category from the front door.
			$html .= '<ul>';
			foreach ( $aq_hubs as $hslug => $h ) {
				$html .= '<li><a href="' . esc_url( home_url( '/' . $hslug . '/' ) ) . '">' . esc_html( $h[0] ) . '</a> — ' . esc_html( $h[2] ) . '</li>';
			}
			$html .= '</ul>';
		}
		global $wpdb;
		$t = $wpdb->prefix . 'aq_notebooks';
		if ( (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) ) === $t ) {
			if ( 'works' === $aq_now ) {
				$rows = $wpdb->get_results( "SELECT id, slug, title FROM {$t} WHERE status = 'published' ORDER BY id DESC LIMIT 500" );
			} else {
				$rows = $wpdb->get_results( $wpdb->prepare(
					"SELECT id, slug, title FROM {$t} WHERE status = 'published' AND kind = %s ORDER BY id DESC LIMIT 500",
					aq_feed_kind_for( $aq_now )
				) );
			}
			if ( $rows ) {
				$html .= '<ul>';
				foreach ( $rows as $r ) {
					$html .= '<li><a href="' . esc_url( aq_notebook_url( $r ) ) . '">' . esc_html( (string) $r->title ) . '</a></li>';
				}
				$html .= '</ul>';
			}
		}
		if ( 'works' !== $aq_now ) {
			$html .= '<p><a href="' . esc_url( home_url( '/works/' ) ) . '">Everything on the Feed</a></p>';
		}
		return $html;
	}

	$post = get_post();
	if ( is_page( 'discussions' ) || ( $post && has_shortcode( (string) $post->post_content, 'aq_discussions' ) ) ) {
		// A specific thread (/discussions/?thread=<id>) is its OWN indexable page — emit the thread
		// (title, author, body, replies) instead of the board, so each discussion is real crawlable
		// content. body/comments were wp_kses_post'd on write; re-filter on output for safety.
		$thread = aq_app_current_thread();
		if ( $thread ) {
			$author = get_userdata( (int) $thread->author_id );
			$html   = '<h1>' . esc_html( $thread->title ) . '</h1>';
			if ( $author ) {
				$html .= '<p>By ' . esc_html( $author->display_name ) . '</p>';
			}
			$html .= '<div>' . wp_kses_post( (string) $thread->body ) . '</div>';
			global $wpdb;
			$comments = $wpdb->get_results( $wpdb->prepare(
				"SELECT body, author_id FROM {$wpdb->prefix}aq_comments WHERE context_type = 'thread' AND context_id = %d ORDER BY id ASC LIMIT 200",
				$thread->id
			) );
			if ( $comments ) {
				$html .= '<h2>Replies</h2>';
				foreach ( $comments as $c ) {
					$ca    = get_userdata( (int) $c->author_id );
					$html .= '<div>' . ( $ca ? '<strong>' . esc_html( $ca->display_name ) . '</strong> ' : '' ) . wp_kses_post( (string) $c->body ) . '</div>';
				}
			}
			return $html;
		}
		// The [aq_discussions] shortcode was removed in the lean cutover — do_shortcode() returned the
		// LITERAL "[aq_discussions]" as both the crawler body and the meta description. Emit a real body:
		// the route summary + the published threads as crawlable links (lean aq_threads; React board is JS-only).
		$seo  = aq_app_route_seo( 'discussions' );
		$html = '<h1>' . esc_html( $seo ? $seo[0] : 'Discussions' ) . '</h1>';
		if ( $seo ) {
			foreach ( $seo[1] as $para ) {
				$html .= '<p>' . esc_html( $para ) . '</p>';
			}
		}
		global $wpdb;
		$rows = $wpdb->get_results( "SELECT id, title, topic FROM {$wpdb->prefix}aq_threads WHERE status = 'publish' ORDER BY id DESC LIMIT 200" );
		if ( $rows ) {
			$html .= '<ul>';
			foreach ( $rows as $r ) {
				$url   = home_url( '/discussions/?forum=' . rawurlencode( $r->topic ? $r->topic : 'general' ) . '&thread=' . (int) $r->id );
				$html .= '<li><a href="' . esc_url( $url ) . '">' . esc_html( $r->title ) . '</a></li>';
			}
			$html .= '</ul>';
		}
		return $html;
	}
	// App pages render their OWN copy in React, NOT the WP post_content — which is stale
	// pre-rebrand marketing ("ArtaQuest", physics/philosophy, the how/why, the retired
	// MOOC pricing table). Serving that to crawlers + no-JS contradicts the live UI on
	// every page AND every locale (locale homes render the old WP front page verbatim).
	// Emit a clean, brand-correct per-route summary instead; the i18n output-buffer
	// translator localizes it at render. (2026-06-03: replaces the stale-post_content path.)
	$slug = is_front_page() ? 'front-page' : ( $post instanceof WP_Post ? $post->post_name : '' );
	$seo  = aq_app_route_seo( $slug );
	if ( $seo ) {
		// Localise the route summary from the mesh cache (no-op in English / when uncached), so non-JS
		// crawlers index the localised body on /xx/ pages instead of English. Prime in one query.
		aq_seo_tr( null, array_merge( array( $seo[0] ), $seo[1] ) );
		$html = '<h1>' . esc_html( aq_seo_tr( $seo[0] ) ) . '</h1>';
		foreach ( $seo[1] as $para ) {
			$html .= '<p>' . esc_html( aq_seo_tr( $para ) ) . '</p>';
		}
		// The home page is the primary crawl seed, but the React AppShell nav is JS-only and absent
		// from this server body — so crawlers (and no-JS visitors) had no links to follow. Emit the
		// main sections as real <a> links so search engines can discover them and pass link equity.
		if ( is_front_page() ) {
			$aq_nav = array(
				'/works/'            => __( 'The Feed', 'artaquest' ),
				'/surveys/'          => __( 'Surveys', 'artaquest' ),
				'/datasets/'         => __( 'Datasets', 'artaquest' ),
				'/models/'           => __( 'Models', 'artaquest' ),
				'/articles/'         => __( 'Articles', 'artaquest' ),
				'/2d-illustrations/' => __( '2D Illustrations', 'artaquest' ),
				'/3d-illustrations/' => __( '3D Illustrations', 'artaquest' ),
				'/2d-animations/'    => __( '2D Animations', 'artaquest' ),
				'/3d-animations/'    => __( '3D Animations', 'artaquest' ),
				'/2d-games/'         => __( '2D Games', 'artaquest' ),
				'/3d-games/'         => __( '3D Games', 'artaquest' ),
				'/music/'            => __( 'Music', 'artaquest' ),
				// Was /discussions/ — retired 2026-07-14 and 301'd to /works/, so the home page's one
				// crawl seed for it pointed at a redirect. /library/ is the live surface it should have
				// been sending crawlers to (every published file, attachable to any member's post).
				'/library/'          => __( 'Library', 'artaquest' ),
				'/about/'            => __( 'About', 'artaquest' ),
				'/data/'             => __( 'Data', 'artaquest' ),
				'/faq-contact/'      => __( 'FAQ & contact', 'artaquest' ),
			);
			$html .= '<nav aria-label="Primary"><ul>';
			foreach ( $aq_nav as $aq_path => $aq_label ) {
				$html .= '<li><a href="' . esc_url( home_url( $aq_path ) ) . '">' . esc_html( $aq_label ) . '</a></li>';
			}
			$html .= '</ul></nav>';
		}
		// FAQ answers live only in React — emit the real Q&A as a definition list so the long-tail
		// answers ("how do I earn the certificate", "what is Arta Coin"…) are crawlable + index-rich,
		// matching the FAQPage JSON-LD. Same source: aq_faq_items(). Localised from the mesh cache
		// (one batched prime) so /xx/ crawlers index the Q&A in-language, not English.
		if ( 'faq-contact' === $slug && function_exists( 'aq_faq_items' ) ) {
			$faq_items = aq_faq_items();
			$faq_strings = array();
			foreach ( $faq_items as $item ) { $faq_strings[] = $item[0]; $faq_strings[] = $item[1]; }
			aq_seo_tr( null, $faq_strings );
			$html .= '<dl>';
			foreach ( $faq_items as $item ) {
				$html .= '<dt><h2>' . esc_html( aq_seo_tr( $item[0] ) ) . '</h2></dt><dd>' . esc_html( aq_seo_tr( $item[1] ) ) . '</dd>';
			}
			$html .= '</dl>';
		}
		return $html;
	}
	// Generic WP pages with no dedicated React route (legal, policy, bursaries, certificate…)
	// are rendered from their real post_content by React's <Page> component — so the crawler
	// layer keeps that same real content. Those bodies are already brand-correct.
	if ( $post instanceof WP_Post ) {
		return '<h1>' . esc_html( get_the_title( $post ) ) . '</h1>' . apply_filters( 'the_content', $post->post_content );
	}
	return '';
}

/**
 * Per-route HEAD meta — the head counterpart to aq_app_seo_html()'s crawler BODY layer. Emits the
 * meta description, Open Graph, Twitter card, and canonical that were entirely ABSENT (0 og/twitter/
 * canonical/description tags sitewide). Title comes from wp_get_document_title(); the description is
 * derived from the SAME aq_app_route_seo() source as the crawler copy (or the post excerpt for
 * generic WP pages), so the social/discovery meta can't drift from the indexed body content.
 * (hreflang for the ~133-locale mesh + a dedicated 1200x630 OG image are follow-ups.)
 */
/**
 * Server-side SEO translation, sourced from the content-addressed mesh's existing cache (no Google
 * call). On /xx/ locale pages the SPA only localises after JS runs, so crawlers + non-JS clients saw
 * English title/description/body even though the hreflang pointed there. This substitutes cached
 * translations (produced by earlier visitors) for the SEO-critical strings, degrading gracefully to
 * English when a string isn't cached yet. Prime once with all the page's strings (one batched query),
 * then translate individually:  aq_seo_tr( null, [ $a, $b, … ] );  $x = aq_seo_tr( $a );
 */
function aq_seo_tr( $s = null, $prime = null ) {
	static $map  = array();
	static $lang = null;
	if ( null === $lang ) {
		$lang = class_exists( '\\AQ\\I18n' ) ? \AQ\I18n::current() : 'en';
	}
	if ( is_array( $prime ) ) {
		if ( 'en' !== $lang && class_exists( '\\AQ\\I18n' ) ) {
			foreach ( \AQ\I18n::cached_many( $prime, $lang ) as $src => $t ) {
				$map[ $src ] = $t;
			}
		}
		return null;
	}
	$s = (string) $s;
	return isset( $map[ $s ] ) ? $map[ $s ] : $s;
}

/**
 * hreflang alternates for the full locale mesh. Given the current page's canonical $url (which
 * already carries the active locale's /xx/ prefix), strip the prefix to the bare English path and
 * re-emit one <link rel="alternate"> per registered locale + an x-default pointing at English.
 * Returns an array of ready-to-print tag strings. No-ops (returns []) if the plugin isn't loaded.
 */
function aq_app_hreflang_links( $url ) {
	if ( ! class_exists( '\\AQ\\I18n' ) ) {
		return array();
	}
	$p = wp_parse_url( $url );
	if ( ! $p || empty( $p['host'] ) ) {
		return array();
	}
	$origin = ( isset( $p['scheme'] ) ? $p['scheme'] : 'https' ) . '://' . $p['host'] . ( isset( $p['port'] ) ? ':' . $p['port'] : '' );
	$path   = isset( $p['path'] ) ? $p['path'] : '/';
	$query  = isset( $p['query'] ) ? '?' . $p['query'] : '';
	// Strip a leading /<locale>/ segment so $path is the language-neutral (English) path. A notebook
	// URL's /nb/<digits> prefix is NOT a locale (the 'nb'/Norwegian collision — see the reclaim shim
	// above aq_app_current_notebook), so it must survive the strip or every alternate would point at
	// /xx/<id>/ instead of /xx/nb/<id>/.
	if ( preg_match( '#^/([a-z]{2,3}(?:-[a-z]{2,4})?)(/.*)$#i', $path, $m ) && strtolower( $m[1] ) !== 'en' && \AQ\I18n::is_locale( $m[1] )
		&& ! ( 'nb' === strtolower( $m[1] ) && preg_match( '#^/[0-9]+(/|$)#', $m[2] ) ) ) {
		$path = $m[2];
	}
	$links = array();
	foreach ( \AQ\I18n::codes() as $code ) {
		$href = ( 'en' === $code ) ? $origin . $path . $query : $origin . '/' . $code . $path . $query;
		// hreflang uses BCP-47: keep the language lowercase, uppercase any region subtag (zh-tw → zh-TW).
		$hl = strpos( $code, '-' ) !== false ? preg_replace_callback( '/-([a-z]+)$/', function ( $r ) { return '-' . strtoupper( $r[1] ); }, $code ) : $code;
		$links[] = sprintf( '<link rel="alternate" hreflang="%s" href="%s" />', esc_attr( $hl ), esc_url( $href ) );
	}
	// x-default → the English (unprefixed) URL, for searchers in unlisted languages/regions.
	$links[] = sprintf( '<link rel="alternate" hreflang="x-default" href="%s" />', esc_url( $origin . $path . $query ) );
	return $links;
}

/** og:locale for the active language (underscored region form, e.g. zh_TW). Empty for unknown. */
function aq_app_og_locale() {
	if ( ! class_exists( '\\AQ\\I18n' ) ) {
		return '';
	}
	$cur = \AQ\I18n::current();
	if ( ! $cur ) {
		return '';
	}
	// schema: facebook wants ll_RR; map our two-letter codes to a sensible default region.
	if ( strpos( $cur, '-' ) !== false ) {
		return preg_replace_callback( '/-([a-z]+)$/', function ( $r ) { return '_' . strtoupper( $r[1] ); }, $cur );
	}
	return $cur;
}

function aq_app_head_meta() {
	if ( ! aq_app_is_app_page() || aq_app_is_dashboard() ) {
		return; // React app routes only; the dashboard is logged-in, not indexed
	}

	$title = wp_get_document_title();
	$desc  = '';
	$type  = 'website';

	$pslug  = get_query_var( 'aq_profile' );
	$post   = get_post();
	$nb     = aq_app_current_notebook();   // /nb/<id>/(<slug>/) — a published feed notebook
	$det    = aq_app_current_detection();  // /news/<slug>/ — one instrument detection
	$thread = aq_app_current_thread();     // /discussions/?thread=<id> — its own indexable forum post
	$puser  = null; // resolved profile user (so the canonical gate knows a /u/<slug>/ is real content)
	if ( $nb ) {
		$desc = trim( wp_strip_all_tags( (string) $nb->abstract ) );
		if ( '' === $desc ) {
			$desc = 'A published work on the ArtaQuest feed — a public Kaggle notebook that has been run, checked against Kaggle\'s public record, credited to its Kaggle author and carrying a permanent DOI short link.';
		}
		$type = 'article';
	} elseif ( $det ) {
		// Describe it the way the page does: an instrument measured something, at a place, at a
		// time. No interpretation — the detector's own words are all this is allowed to claim.
		// The headline usually ALREADY carries the place ("Internet connectivity loss, Hong Kong"),
		// so appending it unconditionally produced "…, Hong Kong, Hong Kong". Append only when the
		// headline does not already say it.
		$where = trim( (string) ( $det->place ?: $det->country ) );
		if ( '' !== $where && false !== stripos( (string) $det->headline, $where ) ) {
			$where = '';
		}
		$meta  = json_decode( (string) ( $det->measures ?? '' ), true );
		$inst  = trim( (string) ( $meta['source']['name'] ?? '' ) );
		$desc  = '' !== $inst
			? sprintf(
				'%s%s — measured by %s. The reading, its full provenance and what it does not establish.',
				(string) $det->headline,
				'' !== $where ? ', ' . $where : '',
				$inst
			)
			: sprintf(
				'%s%s. The reading, its full provenance and what it does not establish.',
				(string) $det->headline,
				'' !== $where ? ', ' . $where : ''
			);
		$type = 'article';
	} elseif ( $thread ) {
		$desc = (string) $thread->body;
		$type = 'article';
	} elseif ( $pslug ) {
		$u = aq_profile_user( $pslug );
		if ( $u ) {
			$puser = $u;
			$pname = aq_profile_name( $u );
			$desc  = trim( (string) get_user_meta( $u->ID, 'description', true ) );
			// LEAD WITH THE NAME even when there is a bio. The description is the snippet under a
			// search result, and a bio rarely repeats the person's own name — so the one query this
			// page exists to answer had no match in the only prose the crawler was given.
			if ( '' !== $desc ) {
				$desc = $pname . ' on ' . get_bloginfo( 'name' ) . ' — ' . $desc;
			} else {
				$n     = count( aq_profile_works( $u->ID, 51 ) );
				$works = $n > 0
					? sprintf( _n( '%d published work', '%d published works', $n, 'artaquest' ), $n )
					: 'their published works';
				$desc  = sprintf(
					'%s on %s — %s, each one a public Kaggle notebook that has been run and checked against Kaggle\'s own record.',
					$pname,
					get_bloginfo( 'name' ),
					$works
				);
			}
			$type = 'profile';
		}
	} else {
		$slug = is_front_page() ? 'front-page' : ( $post instanceof WP_Post ? $post->post_name : '' );
		if ( '' === $slug ) {
			// The Feed hubs (/works/ + the eleven kind hubs) are soft paths with no WP post, so
			// $post resolves nothing and they'd serve NO meta description at all. Key them by path.
			$aq_hub = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
			if ( 'works' === $aq_hub || array_key_exists( $aq_hub, aq_feed_hubs() ) ) {
				$slug = $aq_hub;
			}
		}
		$seo  = aq_app_route_seo( $slug );
		if ( $seo && ! empty( $seo[1][0] ) ) {
			$desc = $seo[1][0];
		} elseif ( $post instanceof WP_Post ) {
			$desc = (string) get_the_excerpt( $post );
		}
	}
	$desc = trim( wp_strip_all_tags( $desc ) );

	// Localise the SERP-facing strings (title + description) from the mesh cache so a /xx/ page serves
	// its localised meta to crawlers + non-JS clients, not English. No-op in English / when uncached.
	// Translate BEFORE truncating: the cache is keyed by the FULL source string (md5), so a string
	// truncated first can never hit it — every non-English meta description silently fell back to English.
	aq_seo_tr( null, array( $title, $desc ) );
	$title = aq_seo_tr( $title );
	$desc  = aq_seo_tr( $desc );
	if ( $desc !== '' && mb_strlen( $desc ) > 160 ) {
		$desc = rtrim( mb_substr( $desc, 0, 157 ) ) . '…';
	}

	// Canonical / og:url: a published notebook → its clean /nb/<id>/<slug>/ URL (the slugless /nb/<id>/
	// form canonicalises onto the slugged one, so the two forms never compete); front page → home; …
	if ( $nb ) {
		$url = aq_notebook_url( $nb ); // self-canonical: each published notebook is its own indexable page
	} elseif ( $thread ) {
		$url = home_url( '/discussions/?forum=' . rawurlencode( $thread->topic ? $thread->topic : 'general' ) . '&thread=' . (int) $thread->id );
	} elseif ( is_front_page() ) {
		$url = home_url( '/' );
	} elseif ( is_singular() && $post instanceof WP_Post ) {
		$url = get_permalink( $post );
	} else {
		global $wp;
		$url = home_url( user_trailingslashit( $wp->request ) );
	}

	// og:image: prefer a content-specific card so social/Discover thumbnails actually depict the page —
	// the notebook's thumb or the profile avatar — falling back to the dedicated 1200×630 brand card.
	// The brand card is a version-controlled theme asset, so it can never 404 the way the old
	// custom_logo attachment did. Regenerate the brand card via tools/brand-kit.py.
	// It is addressed at its brand-kit path, NOT the old assets/images/og-image.png: that name had
	// been served bare (no ?v=) since 2026-06, so WP.com's edge holds a year-cached copy of the
	// RETIRED "Quest" mark there and re-uploading the same name does not dislodge it — every
	// scraper would keep getting the old card. A new path is a guaranteed cache miss, and it drops
	// a duplicate of a file the brand kit already emits. (og-image.png stays on prod, unreferenced,
	// so links shared before today still resolve.)
	$image       = get_theme_file_uri( 'assets/brand/social-card-1200x630.png' );
	$image_w     = 1200;
	$image_h     = 630;
	if ( $nb && ! empty( $nb->thumb ) ) {
		$image = (string) $nb->thumb; // the work's own card
		$image_w = 0; $image_h = 0; // stored thumbs vary in size — don't declare wrong dims
	} elseif ( $puser ) {
		// Verify::avatar_url, NOT get_avatar_url — two reasons, and both are bugs the direct call had.
		// (1) It is what the PAGE shows: an uploaded picture, else a typology pick, else the member's
		// season sigil. get_avatar_url skipped all of that, so the social card and the schema.org
		// image depicted a Gravatar the profile itself does not display.
		// (2) A Gravatar URL is a HASH OF THE EMAIL ADDRESS, which makes an indexable page into an
		// email-confirmation oracle: guess an address, hash it, compare. We had just finished masking
		// those addresses everywhere else (see Extra::REDACT_COLUMNS) — leaving the hash in og:image
		// would have handed back a way to test a guess.
		$av = class_exists( '\AQ\Verify' ) ? \AQ\Verify::avatar_url( $puser->ID, 512 ) : '';
		if ( $av ) { $image = $av; $image_w = 512; $image_h = 512; }
	}

	$tags = array();
	if ( $desc !== '' ) {
		$tags[] = sprintf( '<meta name="description" content="%s" />', esc_attr( $desc ) );
	}
	// No canonical on a GENUINE 404 — it would self-point at a URL that does not exist. But course
	// detail, the lesson player, and discussion threads are soft-resolved content that WP itself
	// marks is_404() (their /courses/<slug>/ etc. rewrites died in the lean cutover), and they're our
	// most important pages — so they MUST still get a canonical + hreflang. Shared genuine-404 test
	// (single source of truth, same gate that controls the wp_robots noindex) keeps the two coherent.
	if ( ! aq_app_is_genuine_404() ) {
		$tags[] = sprintf( '<link rel="canonical" href="%s" />', esc_url( $url ) );
		// hreflang for the ~133-locale mesh: every page exists in every language (translated on first
		// visit), so we declare the full set + x-default. This tells Google to serve the right
		// localised URL to each searcher and stops the locale variants being read as duplicates.
		// Each locale's canonical is self-referencing (its prefixed URL), so the reciprocal hreflang
		// set + self-canonical stay coherent.
		foreach ( aq_app_hreflang_links( $url ) as $hl ) {
			$tags[] = $hl;
		}
		// og:locale for the active language + a few major alternates (Facebook/LinkedIn cards).
		$oglocale = function_exists( 'aq_app_og_locale' ) ? aq_app_og_locale() : '';
		if ( $oglocale !== '' ) {
			$tags[] = sprintf( '<meta property="og:locale" content="%s" />', esc_attr( $oglocale ) );
		}
	}
	$tags[] = sprintf( '<meta property="og:type" content="%s" />', esc_attr( $type ) );
	$tags[] = '<meta property="og:site_name" content="ArtaQuest" />';
	$tags[] = sprintf( '<meta property="og:title" content="%s" />', esc_attr( $title ) );
	if ( $desc !== '' ) {
		$tags[] = sprintf( '<meta property="og:description" content="%s" />', esc_attr( $desc ) );
	}
	$tags[] = sprintf( '<meta property="og:url" content="%s" />', esc_url( $url ) );
	$tags[] = sprintf( '<meta name="twitter:card" content="%s" />', 'summary_large_image' );
	$tags[] = sprintf( '<meta name="twitter:title" content="%s" />', esc_attr( $title ) );
	if ( $desc !== '' ) {
		$tags[] = sprintf( '<meta name="twitter:description" content="%s" />', esc_attr( $desc ) );
	}
	if ( $image !== '' ) {
		$alt = $nb ? (string) $nb->title : ( $puser ? $puser->display_name : 'The ArtaQuest logo on a dark background' );
		$tags[] = sprintf( '<meta property="og:image" content="%s" />', esc_url( $image ) );
		if ( $image_w > 0 && $image_h > 0 ) { // only declare dims we actually know (else let scrapers fetch)
			$tags[] = sprintf( '<meta property="og:image:width" content="%d" />', (int) $image_w );
			$tags[] = sprintf( '<meta property="og:image:height" content="%d" />', (int) $image_h );
		}
		$tags[] = sprintf( '<meta property="og:image:alt" content="%s" />', esc_attr( $alt ) );
		$tags[] = sprintf( '<meta name="twitter:image" content="%s" />', esc_url( $image ) );
	}

	// schema.org DiscussionForumPosting JSON-LD on a thread (the forum-post rich-result type). Replies →
	// schema.org Comment nodes from the unified board: aq_comments with context_type='thread',
	// context_id=thread id (the legacy thread_id column was retired in 1.10.0). flagged (hate/fear)
	// comments are kept out of the rich result, as on the section board. (Helpers live in aq-seo-schema.php,
	// loaded before this file; guarded so a reordered include degrades gracefully instead of fataling.)
	if ( $thread && function_exists( 'aq_seo_forum_comment' ) && function_exists( 'aq_seo_forum_author' ) && function_exists( 'aq_seo_forum_replies' ) ) {
		global $wpdb;
		$crows = $wpdb->get_results( $wpdb->prepare(
			"SELECT c.id, c.body, c.votes, c.created, c.reply_count, u.display_name, u.user_nicename
			   FROM {$wpdb->prefix}aq_comments c
			   LEFT JOIN {$wpdb->prefix}users u ON u.ID = c.author_id
			  WHERE c.context_type = 'thread' AND c.context_id = %d AND c.parent_id = 0 AND c.flagged = 0
			  ORDER BY c.id ASC LIMIT 50",
			(int) $thread->id
		) );
		// Batch-fetch the non-flagged replies for the comments that have any, so each Comment can nest
		// them under `comment` (the field Search Console flagged missing inside each comment).
		$reply_ids = array();
		foreach ( (array) $crows as $cr ) {
			if ( ! empty( $cr->reply_count ) ) {
				$reply_ids[] = (int) $cr->id;
			}
		}
		$replies_by_parent = aq_seo_forum_replies( $reply_ids );
		$tcomments = array();
		foreach ( (array) $crows as $cr ) {
			$kids  = isset( $replies_by_parent[ (int) $cr->id ] ) ? $replies_by_parent[ (int) $cr->id ] : array();
			$cnode = aq_seo_forum_comment( $cr, $kids ); // Person author w/ url; nests replies; skips any text-less one
			if ( $cnode ) {
				$tcomments[] = $cnode;
			}
		}
		// Emit a DiscussionForumPosting on EVERY thread — a thread is a first-hand forum post even before
		// anyone replies, and /discussions/?thread= has NO other rich result to fall back on (a lesson page
		// at least carries its VideoObject; a thread page does not). The OLD gate emitted a posting only
		// when the thread had ≥1 reply, so a reply-less thread emitted nothing at all — which means the
		// error Search Console had already recorded against that URL was never REPLACED by a valid posting
		// on re-crawl, and any test of such a URL still finds no DiscussionForumPosting. Emitting always
		// fixes that, and every posting we emit satisfies on its own the three things Search Console flagged:
		//   1. the REQUIRED one-of text/image/video — we give BOTH `text` (body → title → a generic line,
		//      so it is never empty) AND `image` (the thread page's own social card, a version-controlled
		//      theme asset that cannot 404), so the critical "neither text, image, nor video" error cannot fire;
		//   2. the RECOMMENDED author.url — aq_seo_forum_author always carries one;
		//   3. the RECOMMENDED `comment` — the thread's top-level (non-flagged) replies, each a Comment w/
		//      text + author(url) + datePublished, and each carrying its OWN replies nested under `comment`
		//      (the nested field Search Console flagged missing inside a comment) — added whenever there are
		//      any; a reply-less thread simply has none to list, a soft recommendation not the critical error.
		$author    = get_userdata( (int) $thread->author_id );
		$author_ld = aq_seo_forum_author( $author ? $author->display_name : '', $author ? $author->user_nicename : '' );
		$tbody = trim( wp_strip_all_tags( (string) $thread->body ) );
		if ( '' === $tbody ) {
			$tbody = trim( (string) $thread->title );
		}
		if ( '' === $tbody ) {
			$tbody = 'A discussion on ArtaQuest.';
		}
		$theadline = trim( (string) $thread->title );
		$ld = array(
			'@context'      => 'https://schema.org',
			'@type'         => 'DiscussionForumPosting',
			'headline'      => '' !== $theadline ? $theadline : $tbody,
			'text'          => $tbody,
			'image'         => $image, // the thread page's social card (same asset as og:image) — guarantees one-of text/image/video
			'url'           => $url,
			'datePublished' => gmdate( 'c', (int) $thread->created ),
			'author'        => $author_ld,
			'commentCount'  => (int) $thread->comment_count,
			'interactionStatistic' => array(
				'@type'                => 'InteractionCounter',
				'interactionType'      => 'https://schema.org/CommentAction',
				'userInteractionCount' => (int) $thread->comment_count,
			),
		);
		if ( $tcomments ) {
			$ld['comment'] = $tcomments; // replies: each a Comment w/ text + author(url) + datePublished
		}
		$tags[] = '<script type="application/ld+json">' . wp_json_encode( $ld ) . '</script>';
	}

	// A MEMBER PROFILE — ProfilePage wrapping a Person.
	//
	// The only structured data a profile carried was the sitewide Organization block, which describes
	// the Foundation and says nothing about whose page this is. A search engine had no machine-readable
	// statement that /u/<slug>/ is a person, let alone which person — so the name in the title was the
	// single unsupported signal for the query the page exists to answer.
	//
	// `name` is the real full name and `alternateName` the handle they post under, because both are
	// things somebody might search, and they are usually different here. `mainEntity` is the Person,
	// which is the shape Google documents for a profile page — the page is ABOUT them, it is not
	// itself a person.
	if ( $puser ) {
		$pname   = aq_profile_name( $puser );
		$pbio    = trim( wp_strip_all_tags( (string) get_user_meta( $puser->ID, 'description', true ) ) );
		$pworks  = aq_profile_works( $puser->ID, 50 );
		$person  = array(
			'@type' => 'Person',
			'name'  => $pname,
			'url'   => home_url( '/u/' . $puser->user_nicename . '/' ),
		);
		if ( $puser->display_name && $puser->display_name !== $pname ) {
			$person['alternateName'] = (string) $puser->display_name;
		}
		if ( '' !== $pbio ) { $person['description'] = $pbio; }
		// Same resolver as og:image above — the picture the page actually shows, and never a
		// Gravatar hash of the member's email address.
		$avatar = class_exists( '\AQ\Verify' ) ? \AQ\Verify::avatar_url( $puser->ID, 512 ) : '';
		if ( $avatar ) { $person['image'] = $avatar; }
		// sameAs — the member's own profiles elsewhere. This is the strongest thing a page can say
		// about WHICH person it means: a name is ambiguous and a set of accounts is not, and it is
		// how a search engine reconciles this page with the ones it already knows about. Their
		// values are host-locked at save time (AQ\Auth::LINKS), so nothing arbitrary reaches here.
		if ( class_exists( 'AQ\\Auth' ) ) {
			$plinks = array_values( AQ\Auth::links( $puser->ID ) );
			if ( $plinks ) { $person['sameAs'] = $plinks; }
			// knowsLanguage — schema.org's own property for exactly this, emitted as BCP-47 codes
			// because that is what the vocabulary asks for and what a consumer can act on, where the
			// visible profile shows endonyms a reader recognises. Both come from the one registry.
			if ( class_exists( 'AQ\\I18n' ) ) {
				$plangs = AQ\Auth::languages( $puser->ID );
				if ( $plangs ) { $person['knowsLanguage'] = array_values( $plangs ); }
			}
		}
		if ( $pworks ) {
			// What they are known FOR. Named works are the strongest thing tying a person to a subject,
			// and each is a real indexable URL on this site rather than an assertion about them.
			$person['knowsAbout'] = array_values( array_filter( array_map( function ( $w ) {
				return trim( (string) $w->title );
			}, $pworks ) ) );
			$person['mainEntityOfPage'] = array_map( function ( $w ) {
				return array( '@type' => 'CreativeWork', 'name' => (string) $w->title, 'url' => aq_notebook_url( $w ) );
			}, array_slice( $pworks, 0, 10 ) );
		}
		$tags[] = '<script type="application/ld+json">' . wp_json_encode( array(
			'@context'   => 'https://schema.org',
			'@type'      => 'ProfilePage',
			'url'        => $person['url'],
			'name'       => $pname,
			'mainEntity' => $person,
		) ) . '</script>';
	}

	// Highwire citation_* meta on a published PAPER notebook — the tags Google Scholar reads to index
	// the work (and to populate the author's Scholar profile). Only ever emitted for status='published'
	// (the resolver enforces that), so drafts / in-review works are never advertised to Scholar. Every
	// value is esc_attr/esc_url escaped; empty optional fields (doi) are omitted rather than blanked.
	if ( $nb && 'paper' === (string) $nb->kind ) {
		$sauthor = get_userdata( (int) $nb->author_id );
		$saname  = ( $sauthor && $sauthor->display_name !== '' ) ? $sauthor->display_name : '';
		$tags[]  = sprintf( '<meta name="citation_title" content="%s" />', esc_attr( (string) $nb->title ) );
		if ( $saname !== '' ) {
			$tags[] = sprintf( '<meta name="citation_author" content="%s" />', esc_attr( $saname ) );
		}
		$nbts = aq_notebook_published_ts( $nb );
		if ( $nbts ) {
			$tags[] = sprintf( '<meta name="citation_publication_date" content="%s" />', esc_attr( gmdate( 'Y/m/d', $nbts ) ) );
		}
		$tags[] = '<meta name="citation_publisher" content="ArtaQuest Foundation" />';
		// citation_abstract — Google Scholar reads this to index + match the paper (optional but
		// recommended). Plain-text, length-capped so a very long abstract never bloats the head.
		$cabs = trim( wp_strip_all_tags( (string) $nb->abstract ) );
		if ( $cabs !== '' ) {
			$tags[] = sprintf( '<meta name="citation_abstract" content="%s" />', esc_attr( mb_substr( $cabs, 0, 1500 ) ) );
		}
		if ( '' !== trim( (string) $nb->doi ) ) {
			$tags[] = sprintf( '<meta name="citation_doi" content="%s" />', esc_attr( trim( (string) $nb->doi ) ) );
		}
		$tags[] = sprintf( '<meta name="citation_abstract_html_url" content="%s" />', esc_url( aq_notebook_url( $nb ) ) );
	}

	echo "\n<!-- ArtaQuest per-route SEO meta -->\n" . implode( "\n", $tags ) . "\n";
}
add_action( 'wp_head', 'aq_app_head_meta', 5 );

/**
 * Clean, brand-correct SEO summaries for the React app's own pages, keyed by page slug
 * (or 'front-page' for the home route). Each entry is [ H1, [ paragraph, … ] ] and is the
 * crawler + no-JS layer for pages whose live copy lives in React, not in post_content. The
 * i18n output-buffer translator localizes it at render. Pages NOT listed here fall back to
 * their real post_content (see aq_app_seo_html). Keep this faithful to the React pages'
 * copy and free of retired brand vocabulary (no physics/philosophy/how-why/degrees-of-freedom).
 */
function aq_app_route_seo( $slug ) {
	$b   = 'ArtaQuest';
	$map = array(
		'front-page'  => array(
			'The notebook feed',
			array(
				$b . ' is the notebook feed run by a non-profit. Every published work in every category — surveys, datasets, models, articles, 2D and 3D illustrations, 2D and 3D animations, 2D and 3D games, and music — is a public Kaggle notebook that has been run. Paste the URL of your notebook\'s output page, pick which of its output files to publish, and an exhaustive reproducibility checklist runs against Kaggle\'s public API.',
				'The checklist states four things a stranger can check: the notebook is public, every one of its inputs is public, the run finished and produced these exact files, and it ran with the internet switched off on Kaggle\'s own record — or, if it did not, we say so plainly. Nothing is scored or ranked. You then publish it yourself: a single-use secret goes to your own registered email, and your click plus your device passkey mints the permanent DOI short link.',
			),
		),
		'about'       => array(
			'Work you can check for yourself',
			array(
				$b . ' is a not-for-profit social media for science and education. Every post is a public Kaggle notebook that has been run, checked in the open against Kaggle\'s own public record. Nothing is scored or judged, and only the member who brought a notebook here can publish it, from their own inbox — their click plus their device passkey mints the permanent citation link, which credits the notebook\'s Kaggle author.',
				'It stays free to read, and anyone can run it again on Kaggle for as long as its author keeps it there — which is exactly why that citation link exists: a kernel is owner-editable and deletable, and the link outlives it. The Foundation runs on donations, and every number behind that — every coin, heart and donation — is public.',
			),
		),
		// The courses economy this entry used to describe (enrolments, the creator ladder's revenue
		// share, the 80% prize pool) was purged 2026-07-13, but the page stayed indexed and unnoindexed
		// — so the only thing a crawler or an LLM could read about working here was a product that no
		// longer exists. It now states the live deal, which the React page's own "The deal" section
		// already tells a human.
		'careers'     => array(
			'Create on ' . $b,
			array(
				'Reading, submitting, checking and publishing are all free on ' . $b . ', and the Foundation never takes a cut of a prize pool. Members earn by winning member-founded challenges: every entrant pays the entry fee into the pool, and at the full-moon deadline the most-hearted entry takes the whole pool — an exact tie splits it evenly.',
				$b . ' welcomes the whole spectrum of honest thought, honestly labelled. The only things we filter out are hate and fear.',
			),
		),
		'donate'      => array(
			'Fund a learner, openly',
			array(
				'Donations to the ArtaQuest Foundation are minted into gold-backed Arta Coins and held for learners whose entry fee is a barrier — directed to the general fund or to a community you choose.',
				'Every gift is public: see exactly how donations are received, held, and issued on the foundation\'s live, open books.',
			),
		),
		'pricing'     => array(
			'The same price everywhere',
			array(
				'One Arta Coin is one milligram of real gold — worth exactly the same in every country, with no purchasing-power adjustment and no regional mark-up. Reading is free, and so is submitting a notebook, running the reproducibility checklist and publishing the work.',
				'No subscriptions and no hidden charges. The only coins that change hands are challenge entry fees, and every one of them goes into the pool the most-hearted entry takes at the full moon — the Foundation never takes a cut, because it runs on donations.',
			),
		),
		// (No 'discussions' entry: the standalone forum was retired 2026-07-14 and /discussions/ 301s
		// to /works/, so the only copy it could still serve described course competition boards that
		// no longer exist. Every post now carries its own board.)
		'developers'  => array(
			'The ' . $b . ' API',
			array(
				'Drive ' . $b . ' programmatically — or hand your AI agent the keys. Personal access tokens let any member submit a Kaggle notebook, pick which of its output files to publish, read the full reproducibility checklist with the evidence behind every check, post, comment and enter challenges over a clean REST API, free.',
				'Publication is the one hard limit: a work goes public and mints its permanent DOI only when the member who brought the notebook here clicks the single-use secret sent to their own registered email and signs with their device passkey. No API call, token or AI agent can publish on its own — publication is requested, never taken. Machine-readable contract at /wp-json/aq/v1/api/docs; OpenAPI 3.1 at /wp-json/aq/v1/api/openapi.',
			),
		),
		'rankings'    => array(
			'Rankings',
			array(
				'Live standings of every open challenge on ' . $b . ' — each board ranks its entries by community hearts, and at the challenge\'s full-moon deadline the top entry takes the whole entry-fee pool (ties split evenly).',
			),
		),
		'challenges'  => array(
			'Challenges',
			array(
				'Member-founded challenges on ' . $b . ': anyone can found a challenge — choosing a category, a topic from the sitewide selector, a full-moon deadline and an entry fee — and open it with their own notebook. Every entrant pays the fee into the pool, so the field grows it together; at the full moon the most-hearted entry takes the whole pool (an exact tie splits it evenly). The Foundation never takes a cut — it runs on donations; submitting, checking and publishing are free.',
			),
		),
		'works'       => array(
			'The Feed',
			array(
				'The ArtaQuest feed: posts across eleven categories — surveys, datasets, models, articles, 2D and 3D illustrations, 2D and 3D animations, 2D and 3D games, and music. One rule governs them all: every submission is a public Kaggle notebook that has been run, and its author picks which of that run\'s output files to publish.',
				'Before anything publishes, a reproducibility checklist reads Kaggle\'s public API and reports four checkable facts: the notebook is public, every one of its inputs is public, the run finished and produced these exact files, and it ran with the internet switched off on Kaggle\'s own record — or, if it did not, we say so plainly. Nothing is scored or ranked. The author then confirms publication from their own inbox, and the work carries a permanent DOI short link (artaquest.com/d/n<id>).',
			),
		),
		'surveys'     => array(
			'Surveys',
			array(
				'Survey instruments published on ArtaQuest together with their analysis pipelines. Each survey is a public Kaggle notebook that has been run, holding the instrument and its analysis in one place: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'datasets'    => array(
			'Datasets',
			array(
				'Datasets published on ArtaQuest, each built in code with a datasheet. A dataset here is a public Kaggle notebook that has been run, constructing and documenting its own data: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'models'      => array(
			'Models',
			array(
				'Models published on ArtaQuest, each trained in the notebook itself. A model here is a public Kaggle notebook that has been run, with its training and evaluation on Kaggle\'s public record: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'articles'    => array(
			'Articles',
			array(
				'Articles published on ArtaQuest, where every claim is computed in place. An article here is a public Kaggle notebook that has been run, its figures and claims produced by that run: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'faq-contact' => array(
			'FAQ & contact',
			array(
				'Answers to common questions about ' . $b . ' — how publishing, the reproducibility checklist, challenges, coins, sponsors, and donations work — and how to reach us.',
			),
		),
		'issues'      => array(
			'Help shape ' . $b,
			array(
				'Report a bug, request a feature, suggest an improvement, or share an idea. ArtaBot triages it with you in the open, the best contributions ship automatically, and resolving your own contribution earns you a point on its leaderboard.',
			),
		),
		'reserve'     => array(
			'The ' . $b . ' gold reserve',
			array(
				'Every Arta Coin is backed one-for-one by a milligram of real gold. This page shows the live price, the reserve, and the backing ratio — proof, not promises, refreshed continuously.',
			),
		),
		'finances'    => array(
			'The ' . $b . ' Foundation\'s books',
			array(
				'Every cent the Foundation has spent or received, as a double-entry ledger anyone can check: the statements, the invoice register with every supporting PDF, and the year-end return prepared straight from the numbers.',
			),
		),
		'wallet'      => array(
			'Your wallet',
			array(
				'Your gold-backed Arta Coins: win them by taking a challenge pool, buy more at the live gold rate, and cash out whenever you like. Every movement is on the public ledger.',
			),
		),
		'data'        => array(
			'Open data',
			array(
				$b . ' publishes its entire database — works, coins, hearts, challenges, donations, every table and row. Browse it, query it, build on it: transparency you can inspect for yourself.',
			),
		),
		'2d-illustrations' => array(
			'2D Illustrations',
			array(
				'Procedural artworks published on ArtaQuest. Each 2D illustration is a public Kaggle notebook that has been run, drawing the piece it presents: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'3d-illustrations' => array(
			'3D Illustrations',
			array(
				'Scenes built as real geometry on ArtaQuest. Each 3D illustration is a public Kaggle notebook that has been run, publishing its Wavefront OBJ scene beside the view it renders: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'2d-animations' => array(
			'2D Animations',
			array(
				'Animations published on ArtaQuest, each rendered from code. A 2D animation here is a public Kaggle notebook that has been run, rendering every frame it shows: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'3d-animations' => array(
			'3D Animations',
			array(
				'Camera flights through built scenes on ArtaQuest. Each 3D animation is a public Kaggle notebook that has been run, publishing its geometry beside the render: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'2d-games'    => array(
			'2D Games',
			array(
				'Playable self-contained games published on ArtaQuest. Each 2D game is a public Kaggle notebook that has been run, publishing everything it needs to play: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'3d-games'    => array(
			'3D Games',
			array(
				'Playable worlds with real depth on ArtaQuest. Each 3D game is a public Kaggle notebook that has been run, its perspective mathematics its own: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'music'       => array(
			'Music',
			array(
				'Music published on ArtaQuest, every track rendered by a generative model the notebook trains in its own cells. The trained weights are published beside the audio in the standard safetensors container, carrying the sha256 of the track they render, so anyone can fetch them from the work\'s permanent address and render the piece again.',
				'Each piece is a public Kaggle notebook that has been run: its author picks which of the run\'s output files to publish, a reproducibility checklist reads Kaggle\'s public API — public notebook, public inputs, a finished run that produced these exact files, and whether it ran with the internet switched off — and the author confirms publication from their own inbox. Every published work carries a permanent DOI short link.',
			),
		),
		'login'       => array(
			'Sign in to ' . $b,
			array(
				'Sign in to ' . $b . ' with a one-time email code or your Google account. No passwords — nothing to remember, reset, or leak.',
			),
		),
		'sponsors'    => array(
			'Sponsors',
			array(
				$b . ' is funded by sponsors — funding programmes and industry partners — and we win them in the open: every opportunity we track is posted here with its deadline. Claim one to help us apply and earn Sponsor points equal to the amount we win.',
			),
		),
		'fearometer'  => array(
			'ArtaMod',
			array(
				'Question everything; fear no one. ' . $b . ' filters exactly one thing — hate and fear — automatically and identically for everyone. This page shows precisely how, with the full study set behind it.',
			),
		),
		'offline'     => array(
			'Use ' . $b . ' offline',
			array(
				'Save the whole app, your language and any music, video or paper onto your device, then keep reading and listening with no connection — built for places where the internet is slow, costly, or blocked.',
			),
		),
		// The Library — the shared shelf every published output file lands on (Kaggle reset,
		// 2026-07-28). It shipped with no description at all, so search results showed the
		// boilerplate site blurb for the surface the whole reset exists to produce.
		// A job posting is pasted into messages and searched for by title, so both matter here more
		// than on an ordinary page.
		'ceo'         => array(
			'CEO',
			array(
				'Run creative and educational challenges with a prize pool at ' . $b . ', a registered Canadian not-for-profit. Recent grad, Arts/Communication/Architecture, fully remote from anywhere in the world, flexible hours. Apply by messaging the CTO your CV.',
			),
		),
		'library'     => array(
			'Library',
			array(
				'Every file published on ' . $b . ' — music, video, images, datasets, models and papers — each one produced by a Kaggle notebook anyone can re-run. Free to play, download and attach to your own posts.',
			),
		),
		'my-library'  => array(
			'My Library',
			array(
				'Your own music, videos and documents, held on this device and playable with no connection — including anything you saved out of the ' . $b . ' Library.',
			),
		),
		'user-account' => array(
			'Your account',
			array(
				'Manage your ' . $b . ' account, progress, and preferences.',
			),
		),
	);
	return isset( $map[ $slug ] ) ? $map[ $slug ] : null;
}

/**
 * Brand name in <title> + anywhere blogname leaks. The stored option is still the intermediate
 * "Aquest" from the rebrand, so every page title read "… – Aquest" while og:site_name, the JSON-LD
 * Organization, and the logo all say "ArtaQuest" — an inconsistent brand signal that hurts SERP
 * recognition + click-through. Force the canonical name in code so it's correct in every environment
 * (and deploys with the theme), regardless of the DB value. Canonical brand: ArtaQuest.
 */
add_filter( 'pre_option_blogname', function () {
	return 'ArtaQuest';
} );

/**
 * The site TAGLINE, forced in code for exactly the reason blogname is above: the stored option is
 * still the MOOC-era line ("The best free knowledge, in one focused, safe place") from before the
 * 2026-07-13 notebook reset, and WordPress appends it to the front page's <title> — so the single
 * most-read string ArtaQuest has in search results advertised a platform that no longer exists,
 * while every other surface described the notebook feed. Owning it here means it deploys with the
 * theme and is right in every environment, whatever the database says.
 */
add_filter( 'pre_option_blogdescription', function () {
	return 'Reproducible notebooks, published in a feed';
} );

/**
 * The FAQ as plain-text Q&A — the single server-side source for both the crawler BODY (so the
 * answers are indexable, not client-only) and the FAQPage JSON-LD. Mirrors the React page
 * artaquest-web/src/pages/FaqContact.tsx (SECTIONS): keep the two in sync — links in the React
 * answers are flattened to plain prose here. Each entry is [ question, answer ].
 */
function aq_faq_items() {
	return array(
		array( 'What is ArtaQuest?', 'A social feed of citable, reproducible work. Every submission — survey, dataset, model, article, 2D or 3D illustration, 2D or 3D animation, 2D or 3D game, or music — is a public Kaggle notebook that has been run. The author pastes the URL of the notebook\'s output page, picks which of its output files to publish, and an exhaustive reproducibility checklist runs against Kaggle\'s public API before the author publishes the work from their own inbox. Published files land in the Library, where any member can attach them to their posts. Reading everything is free, no account needed.' ),
		array( 'How do I publish a work?', 'Paste a Kaggle notebook URL, pick the files to publish, read the checklist, request publication, then confirm from your inbox. That is the whole flow. The checklist\'s blocking checks all have to pass; then a single-use secret goes to your own registered email, and your click plus your device passkey signature is what publishes the work and mints its permanent DOI short link. Every step is free.' ),
		array( 'How is a work checked?', "It is checked, not judged — nothing here is scored, ranked or graded. A reproducibility checklist runs about twenty deterministic checks in four groups: can anyone open it, can anyone re-run it, did that run produce these files, how repeatable is the result. Every check names the exact evidence it read from Kaggle's public API. Blocking checks must all pass; warnings are shown loudly and never block. Because the Kaggle pages the checklist reads answer without a login, the whole checklist is a public assertion anyone can re-run and contradict." ),
		array( 'Why must every work be a public Kaggle notebook?', 'Because that is what makes it checkable by a stranger. Reproducible here means anyone can hit Copy & Edit then Run All on Kaggle, from public inputs, and get this — weaker than a byte-for-byte guarantee, stronger than taking our word for a run on our own machine. Kaggle runs the notebook and enforces the internet switch; we read and report what its record says. The Kaggle kernel is the provenance, and the DOI short link (artaquest.com/d/n<id>) is the citation of record, because a kernel is owner-editable and deletable and a DOI is not.' ),
		array( 'Do I need an account?', 'You can read, play and listen to everything without one — and re-run any work yourself on Kaggle. A free account is needed to post, heart, publish and enter challenges. Signing up takes under a minute and needs only an email address; there are no passwords, ever.' ),
		array( 'Can I join if I am under 18?', 'Members aged 13 and over may register with parental or guardian consent. Buying Arta Coins, or any other payment, requires the account holder to be 18 or older, or a parent or guardian to complete the transaction.' ),
		array( 'How do challenges work?', 'A challenge is founded by a member: pick a kind, a sitewide topic and a full-moon deadline, set the entry fee, and open it with your own notebook — the founder pays in like everyone else. Every entrant\'s fee goes straight into the pool, and at the full moon the most-hearted entry takes the whole pool; an exact tie splits it evenly. The Foundation never takes a cut.' ),
		array( 'How do I enter a challenge?', "With your own work of the challenge's kind — a public Kaggle notebook that has cleared the checklist and that you have published from your own inbox. Pay the entry fee — all of it goes into the pool — one entry per member per challenge. At the deadline only the hearts decide." ),
		array( 'Why hearts instead of up and down votes?', "Because taste needs no negative. You heart what you love — one heart per member per reply or work, never your own — and the counts rank the boards. There is nothing to downvote: content that trades in hate or fear is handled by ArtaMod, not by pile-ons, and everything else deserves to stand on the love it earns. Every heart is public in the Data explorer." ),
		array( "What's the difference between coins and points?", "Two different things. Arta Coins are money — gold-backed, spendable, cashable; you win them by taking a challenge pool. Points are standing — a lifetime tally of what you've contributed that sets your rank (Quester to Legend). You earn points by creating (publishing works), engaging (a point for each reply you post), donating (a point per coin given), and volunteering (resolved contributions, shares, referrals). Spending coins never lowers your points." ),
		array( 'How do I donate?', 'Go to the Donate page, pick or enter an amount, and continue to checkout. Pay by Interac e-Transfer or card; you will see payment instructions immediately. We confirm receipt within 1–2 business days.' ),
		array( 'What is Arta Coin (₳)?', "Arta Coin (₳) is ArtaQuest's currency. Each coin is a claim on one milligram of real gold, and the Reserve page publishes the live ratio of gold held to coins issued — so you can check the backing yourself instead of taking our word for it. A coin is worth the same in every country. You win coins by taking challenge pools, and you can buy or cash them out at the live gold rate from your Wallet." ),
		array( 'Why is the donation in CAD?', 'The foundation banks in Canada, so checkout is denominated in Canadian dollars. Card payments convert your local currency automatically; Interac is for Canadian bank accounts.' ),
		array( 'What can I do with Arta Coins?', 'Found or enter challenges, donate them to the member fund (which also earns you donor points), or cash them out for ordinary money at the live gold rate from your Wallet. Every coin is a claim on one milligram of gold; the live backing ratio is on the Reserve page.' ),
		array( 'Can I get a tax receipt?', 'Not an official one, and we would rather say so plainly than leave you to find out at tax time. ArtaQuest Foundation is a Canadian non-profit corporation, not a registered charity, and CRA does not permit a non-profit to issue official donation receipts — so a gift to us is not tax-deductible. Every donation does trigger an email confirmation you can keep as a record, and every cent of it appears in the Foundation’s published books, on the Finances page.' ),
		array( 'Can I get my donation back?', 'Donations are non-refundable in general (see the Refund Policy), except for duplicate or unauthorised payments. Coins minted for a refunded donation are reversed.' ),
		array( 'What is a bursary for?', 'So that cost never decides who takes part. Through the Sponsors programme, donors earmark Arta Coins to a community, and bursaries draw on that fund. Where it stands today: the bursary form still covers the retired course fee, not a challenge entry, so it cannot pay a challenge fee yet — we would rather say so than send you to a form that cannot help. Every coin in the fund is public in the ledgers meanwhile.' ),
		array( 'What proof of income do I need for a bursary?', 'One document is enough: a CRA Notice of Assessment, a government benefit letter (AISH, Alberta Works, Income Support, or equivalent), a credit rating report classifying your income as Low, or another means-tested document.' ),
		array( 'Is ArtaQuest a registered organisation?', 'Yes. ArtaQuest Foundation is a registered Canadian non-profit. It operates exclusively for educational purposes and distributes no profit to members. The non-profit structure is deliberate — it protects the platform\'s independence from being acquired, monetised, or quietly steered off its mission.' ),
		array( "What is ArtaQuest's position on AI?", 'An AI is trained to give you its single most likely answer — to collapse a world of possibilities into one. As a tool, that is powerful. As a substitute for thinking, it quietly narrows what people believe is possible, and rewards accepting the average answer over working one out. It also burns a great deal of energy. ArtaQuest was built in response — not against the technology, but for the human faculty it cannot replace: the ability to think for yourself, and to widen a question the machine has narrowed.' ),
		array( 'Does ArtaQuest promote a particular ideology or worldview?', 'No. We do not advocate for any tradition, denomination, or political position, and we accept no funding that would pull us toward one. We bring you the best free knowledge we can find, present the strongest honest case for competing positions, and let you reach your own conclusion rather than handing you one. No fear-mongering, no hate speech, no propaganda.' ),
		array( "Where does ArtaQuest's funding come from?", 'Donations. Submitting, checking and publishing are all free, and challenge pools are never touched: 100% of entry fees returns to the winning entrants. Every gift, every coin and every gold figure is in the open ledgers — see the live Reserve and the Data explorer.' ),
		array( 'Does ArtaQuest have charitable status for tax receipts?', 'No. We are incorporated as a Canadian non-profit and rely on the paragraph 149(1)(l) income-tax exemption; we have not obtained charitable registration from the Canada Revenue Agency, and until we do we cannot issue official donation receipts. If that ever changes, this page will say so first.' ),
	);
}

/**
 * RETIRED routes → the Notebook Feed (2026-07-13 total redesign): every pre-feed
 * surface 301s to its nearest new home, keyed on the FIRST path segment so deep forms
 * (/courses/<slug>/<id>, /challenges/<kind>, /topics?field=…) redirect too. Runs at parse_request —
 * BEFORE the main query decides the 404 — because template_redirect-time wp_safe_redirect silently
 * no-ops for 404-resolved paths under local PHP-WASM (see the iter-364 note in
 * mu-plugins/aq-legacy-redirects.php). The i18n Router has already stripped any /xx/ prefix from
 * REQUEST_URI by now (belt-and-braces strip below), and home_url() re-adds the active locale, so
 * the hops stay locale-correct. Still-live routes (/, /about, /wallet, /donate, /sponsors, /reserve,
 * /data, /careers, /issues, /faq-contact, /login, /user-account, /u/<slug>, /library, /challenges,
 * /offline, /fearometer, /pricing, /d/<code>, /works + the eleven kind hubs, /nb, /studio, /console,
 * /certificate, /verify) never match this map. (/discussions is NOT one of them — it is in the map
 * below.) Anything that reads a QUERY STRING is doubly unsafe here: this map redirects to a bare
 * home_url() path, so a match does not merely move the reader, it silently deletes their parameters.
 */
add_action( 'parse_request', function () {
	$path = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	if ( '' === $path ) {
		return;
	}
	$segs = explode( '/', $path );
	// Belt-and-braces locale-prefix strip (mirrors mu-plugins/aq-legacy-redirects.php).
	if ( count( $segs ) > 1 && class_exists( '\\AQ\\I18n' ) && 'en' !== strtolower( $segs[0] ) && \AQ\I18n::is_locale( $segs[0] ) ) {
		array_shift( $segs );
	}
	$seg = strtolower( (string) $segs[0] );
	$map = array(
		// The old learning arena → the feed kinds.
		'courses'          => '/playlists/', // hub, detail AND the /courses/<slug>/<id> player
		'video'            => '/playlists/',
		'lesson'           => '/playlists/',
		// 'library' is NOT a legacy segment any more (operator 2026-07-28): /library/ is THE Library —
		// every published file, attachable to any member's post, and the headline surface of the
		// Kaggle reset. It sat in this map, so the one nav entry pointing at it 301'd to /books/ and
		// on to /articles/: the surface could not be opened, shared, bookmarked or crawled.
		'read'             => '/books/',
		'films'            => '/animations/',
		'film'             => '/animations/',
		'watch'            => '/animations/',
		'illustration'     => '/illustrations/',
		'artaillustration' => '/illustrations/',
		'research'         => '/papers/',
		'artascience'      => '/papers/',
		'competitions'     => '/datasets/',
		'competition'      => '/datasets/',
		'game'             => '/games/', // the /games/ hub itself stays live
		// Retired audio surfaces → the music hub (every kind funnels to its own hub).
		'listen'           => '/music/',
		'artasound'        => '/music/',
		// Retired studio / discovery surfaces → the feed front door.
		'artatranslate'    => '/works/',
		'explore'          => '/works/',
		// /topics RESTORED (operator 2026-07-15/16): the seasonal topic atlas is live again.
		'typologies'       => '/works/',
		'typology'         => '/works/',
		'skills'           => '/works/',
		'fields'           => '/works/',
		'professions'      => '/works/',
		'astro'            => '/works/',
		'why'              => '/works/',
		'cycles'           => '/works/',
		'shop'             => '/works/',
		'discussions'      => '/works/', // forum retired 2026-07-14 — every post carries its own board
		'arena'            => '/games/', // arena retired 2026-07-14 — games live fully inside the feed
		// Transactional renames.
		'enroll'           => '/wallet/',
		'cart'             => '/wallet/',
		// 'checkout' was reaching /wallet/ as a 302 from elsewhere while every other retired slug
		// here is a 301. A retired path is permanently retired: a 302 tells a crawler to keep asking.
		'checkout'         => '/wallet/',
		// 'verify' and 'certificate' are NOT retired and must never return to this map. Both are LIVE
		// React routes (App.tsx → pages/Participation.tsx) behind real published WP pages, and both
		// carry their meaning in the QUERY STRING — /certificate/?challenge=<id> for the holder's own
		// Certificate of Participation, /verify/?p=<ch>&u=<uid>&k=<hmac> for the public authenticity
		// check. This map runs at parse_request priority 1, so it intercepted before is_page() could
		// resolve, and home_url('/') drops the query: the verify URL PRINTED ON THE CERTIFICATE
		// (components/participation.tsx: 'artaquest.com/verify') sent every reader to the home page
		// with their code discarded, and the certificate itself was unreachable. Producers of those
		// links: Credits.php (verify_url / certificate url), Notebook.php (challenge entry) and
		// Extra.php. They stay noindex + out of the sitemap via aq_app_noindex_page_slugs() — an
		// HMAC-bearing URL should never be indexed — which is a page-level policy, not a redirect.
	);
	if ( isset( $map[ $seg ] ) ) {
		wp_safe_redirect( home_url( $map[ $seg ] ), 301 );
		exit;
	}
}, 1 );

/**
 * /app/ was the old dashboard URL; the dashboard is now home (/). 301-redirect the
 * legacy "App" page to the front page so old links, bookmarks, and crawlers land on
 * the canonical home. (The React router also redirects /app client-side as a fallback.)
 */
add_action(
	'template_redirect',
	function () {
		if ( is_page( 'app' ) ) {
			wp_safe_redirect( home_url( '/' ), 301 );
			exit;
		}
		// WC checkout page is retired — checkout/cart surfaces now consolidate on the React wallet
		// (/cart/ + /enroll/ 301 there in the parse_request map above). Keep WC endpoints
		// (order-received / order-pay) so existing order links still resolve.
		if ( is_page( array( 'checkout', 'checkout-3' ) ) && ! ( function_exists( 'is_wc_endpoint_url' ) && is_wc_endpoint_url() ) ) {
			wp_safe_redirect( home_url( '/wallet/' ), 302 );
			exit;
		}
		// The React /user-account/ is the canonical account (everything-React). Redirect the bare WC
		// account dashboard there; keep WC endpoints (orders, order-received/pay, edit-address,
		// lost-password, customer-logout…) resolving so transactional + auth links still work.
		if ( is_page( 'my-account' ) && ! ( function_exists( 'is_wc_endpoint_url' ) && is_wc_endpoint_url() ) ) {
			wp_safe_redirect( home_url( '/user-account/' ), 301 );
			exit;
		}
		// /wishlist/ is an empty, unused placeholder (no wishlist feature/plugin; nothing links to it).
		// Send any direct or bookmarked visitor to the playlists hub instead of a blank page.
		if ( is_page( 'wishlist' ) ) {
			wp_safe_redirect( home_url( '/playlists/' ), 301 );
			exit;
		}
		// Renamed surface: /outreach → /grants (2026-06-07) → /sponsors (2026-06-18). The legacy pages
		// are kept published purely as these 301 anchors; home_url() keeps them locale-correct.
		if ( is_page( 'outreach' ) || is_page( 'grants' ) ) {
			wp_safe_redirect( home_url( '/sponsors/' ), 301 );
			exit;
		}
		if ( is_page( 'almanac' ) || is_page( 'recommendations' ) ) { // both legacy slugs are 301 anchors → Home
			wp_safe_redirect( home_url( '/' ), 301 );
			exit;
		}
		// (typology/skills/fields/professions/astro/lesson/video/topics/typologies all 301 in the
		// parse_request feed map above — their old per-page handlers left with the redesign.)
	},
	0
);

/**
 * Soft-404 guard. WP resolves a deep unmatched path (e.g. /unknown/deep/path/) to the front-page
 * query, and redirect_canonical then 301s it to the bare home URL — a soft-404 (a dead URL that
 * returns 200 via home, which crawlers penalise). When the canonical target IS home but the request
 * asked for a different URL, force a real 404 instead. Legit canonical fixes target the correct page
 * URL (never home), so they are untouched; the i18n router already cancels canonical on locale URLs.
 */
add_filter(
	'redirect_canonical',
	function ( $redirect_url, $requested_url ) {
		if ( $redirect_url
			&& untrailingslashit( (string) $redirect_url ) === untrailingslashit( home_url( '/' ) )
			&& untrailingslashit( (string) $requested_url ) !== untrailingslashit( home_url( '/' ) ) ) {
			global $wp_query;
			if ( $wp_query instanceof WP_Query ) {
				$wp_query->set_404();
			}
			status_header( 404 );
			nocache_headers();
			return false;
		}
		return $redirect_url;
	},
	20,
	2
);

/**
 * A 404 must not advertise itself as indexable. WordPress's default wp_robots still emits
 * `max-image-preview:large` on a 404 response — a positive crawl signal that contradicts the 404
 * status header. Force `noindex` and drop the now-moot preview hints so the directive is coherent.
 * (The dashboard/private pages are noindexed separately in template-aq-app.php, which skips wp_head
 * entirely, so this filter never runs for them.)
 */
add_filter( 'wp_robots', function ( $robots ) {
	// Only a GENUINE 404 should be noindexed. Course detail (/courses/<slug>/), the lesson player,
	// discussion threads, and profiles are is_404() in WP's eyes (their rewrites died in the lean
	// cutover) but are REAL, indexable content — noindexing them blocks our most important pages from
	// Google. Use the same genuine-404 test as the canonical layer (was: raw is_404(), which over-reports).
	if ( aq_app_is_genuine_404() ) {
		$robots['noindex'] = true;
		unset( $robots['max-image-preview'], $robots['max-snippet'], $robots['max-video-preview'] );
	}
	return $robots;
} );

/**
 * A request is a GENUINE 404 only when WordPress 404s AND none of our soft-resolved content routes
 * matched. Course/lesson/thread/profile URLs are served by the React app and marked is_404() by WP
 * (no matching rewrite post-cutover), so raw is_404() over-reports — it would noindex real pages and
 * suppress their canonical. Single source of truth for "really nothing here".
 */
function aq_app_is_genuine_404() {
	// The soft-404 guards (dead lesson/thread/profile id) force a 404 STATUS via status_header()
	// without flipping WP's is_404() conditional (the underlying page is real, only the query-param
	// target is missing). Honour that forced status so such a 404 is coherently noindexed + canonical-
	// free, instead of emitting an indexable canonical on a page that returns 404. Runs after the
	// priority-1/6 template_redirect guards, so the status is already set by wp_head time.
	if ( function_exists( 'http_response_code' ) && 404 === (int) http_response_code() ) {
		return true;
	}
	if ( ! is_404() ) {
		return false;
	}
	if ( aq_app_current_notebook() ) {
		return false; // a published notebook at /nb/<id>/(<slug>/) is real, indexable content
	}
	if ( function_exists( 'aq_app_current_detection' ) && aq_app_current_detection() ) {
		return false; // an ArtaNews detection at /news/<slug>/ is real, indexable content
	}
	$aq_404_path = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	if ( 'works' === $aq_404_path || array_key_exists( $aq_404_path, aq_feed_hubs() ) ) {
		return false; // the Feed front door + the eleven kind hubs are real, indexable pages
	}
	if ( aq_app_is_private_soft_path() ) {
		return false; // /console/ + /studio/nb/<id>/ are real (member-only, noindex) surfaces, not 404s
	}
	if ( function_exists( 'aq_app_current_thread' ) && aq_app_current_thread() ) {
		return false;
	}
	$pslug = get_query_var( 'aq_profile' );
	if ( $pslug && function_exists( 'aq_app_profile_user_exists' ) && aq_app_profile_user_exists( $pslug ) ) {
		return false;
	}
	return true;
}

/**
 * Does a /u/<slug>/ profile actually exist? Matches both the React route (user_nicename) and
 * the legacy renderer (user_login), so a real member resolves and a bogus slug does not.
 */
function aq_app_profile_user_exists( $slug ) {
	$slug = sanitize_title( $slug );
	if ( '' === $slug ) {
		return false;
	}
	return (bool) ( get_user_by( 'slug', $slug ) ?: get_user_by( 'login', $slug ) );
}

/**
 * The /u/<slug>/ profile route renders via template_redirect (echo+exit) in
 * aq-public-profile.php, which fires before template_include — so preempt it here
 * at priority 1 and serve the React app template instead (profile is now React).
 */
add_action(
	'template_redirect',
	function () {
		if ( get_query_var( 'aq_profile' ) ) {
			// Soft-404 guard: /u/<slug>/ for a user that does not exist must return HTTP 404 (not 200)
			// so crawlers do not index dead profile URLs. The React app still renders its friendly
			// "No public profile" state — we only correct the status code.
			$aq_pslug = (string) get_query_var( 'aq_profile' );
			if ( '' !== $aq_pslug && ! aq_app_profile_user_exists( $aq_pslug ) ) {
				status_header( 404 );
			}
			$bare = get_theme_file_path( 'template-aq-app.php' );
			if ( file_exists( $bare ) ) {
				include $bare;
				exit;
			}
		}
	},
	1
);

/**
 * Soft-404 guard for the discussion thread view (/discussions/?thread=<id>) — a ?param= view of an
 * existing WP page, so a bad/missing id otherwise returns a 200 soft-404 (the page exists) and
 * crawlers would index dead URLs. aq_app_current_thread() already resolves the id against aq_threads;
 * when a positive id was requested but resolves to null, force a real 404. The React app still
 * renders its own "unavailable" state — we only correct the status code.
 */
add_action( 'template_redirect', function () {
	// phpcs:disable WordPress.Security.NonceVerification
	if ( is_page( 'discussions' ) && isset( $_GET['thread'] ) && (int) $_GET['thread'] > 0 && ! aq_app_current_thread() ) {
		status_header( 404 );
		nocache_headers();
	}
	// phpcs:enable WordPress.Security.NonceVerification
}, 6 );

/**
 * The ArtaNews detection at the current /news/<slug>/ URL, or null.
 *
 * Same shape as aq_app_current_notebook(): the URL is served by React and is_404() to WP, so the
 * path is detected here and the row sourced from the same table the /aq/v1 API reads. Resolving to
 * a ROW rather than to the path is what keeps a mistyped or retired slug on its hard 404 — a soft
 * route that 200s for any string invents pages for crawlers.
 *
 * The slug pins the event by its trailing -e<id>, which is why a regenerated headline cannot orphan
 * a URL that is already published; the fallback to `ekey` covers rows published before that scheme.
 * Memoised, and safe on a cold site where the table does not exist yet.
 */
function aq_app_current_detection() {
	static $cache = false;
	if ( false !== $cache ) {
		return $cache;
	}
	$cache = null;
	$path  = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	$path  = preg_replace( '#^[a-z]{2}/#', '', $path ); // strip a locale prefix, as the guess-map does
	if ( ! preg_match( '#^news/([a-z0-9-]+)$#', $path, $m ) ) {
		return $cache;
	}
	$slug = $m[1];
	global $wpdb;
	$t = $wpdb->prefix . 'aq_news_events';
	if ( (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) ) !== $t ) {
		return $cache;
	}
	// Columns as aq_news_events actually defines them: the headline is `headline`, and the time is
	// first_ts/last_ts. Only what the SEO layer needs is selected — `pixels` is LONGTEXT and this
	// runs on every request to a /news/ URL.
	// `measures` carries the source block, which holds the INSTRUMENT's name. The `detector`
	// column is a registry key ('netloss') whose label is a signal TYPE ('Internet connectivity
	// loss') — neither is the thing that measured this, so neither belongs after "measured by".
	$cols = 'id, ekey, headline, detector, place, country, first_ts, last_ts, status, measures';
	$cache = preg_match( '/-e([0-9]+)$/', $slug, $e )
		? $wpdb->get_row( $wpdb->prepare( "SELECT {$cols} FROM {$t} WHERE id = %d", (int) $e[1] ) )
		: $wpdb->get_row( $wpdb->prepare( "SELECT {$cols} FROM {$t} WHERE ekey = %s", $slug ) );
	return $cache;
}

/**
 * 200-correction for the Notebook Feed soft routes: the Feed front door (/works/), the
 * eleven kind hubs, a PUBLISHED notebook (/nb/<id>/(<slug>/)) and the member-only /console/ +
 * /studio/nb/<id>/ editors are real content but is_404() to WP (no post). Correct the status so the
 * indexable ones earn a canonical + are indexed (an unknown/unpublished /nb/<id> keeps the hard 404 →
 * noindex, since the resolver returns null; /console/ + /studio/nb/ render 200 but noindex'd as
 * dashboard surfaces).
 */
add_action( 'template_redirect', function () {
	$path = trim( (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH ), '/' );
	$soft_public = ( 'works' === $path || array_key_exists( $path, aq_feed_hubs() )
		|| aq_app_current_notebook() || aq_app_current_detection() );
	if ( $soft_public || aq_app_is_private_soft_path() ) {
		status_header( 200 );
	}
	// AND LET THE EDGE KEEP THEM. These are is_404() to WP, so core's send_headers() has already
	// attached no-cache/no-store — it runs on `wp`, before this hook, so correcting the STATUS left
	// the caching untouched. The result: /works/ and all eleven kind hubs, the busiest public pages
	// on the site, re-executed WordPress at origin on every single view, while / and /about/ (real
	// pages) were served from the edge.
	//
	// Only for a signed-OUT visitor, and only for the public soft routes. The shell injects
	// window.AQ_USER and a nonce, so a member's response must never be shared — for them the
	// no-store above is correct and stays. Anonymously AQ_USER is null, and this is exactly what
	// the front page already does (max-age=30, must-revalidate), so it is the site's own pattern
	// rather than a new policy. Private surfaces (/console/, /studio/nb/) are excluded outright.
	if ( $soft_public && ! is_user_logged_in() && ! headers_sent() ) {
		header_remove( 'Cache-Control' );
		header_remove( 'Pragma' );
		header_remove( 'Expires' );
		header( 'Cache-Control: max-age=30, must-revalidate' );
		return;
	}

	// AND EVERY OTHER SHELL RESPONSE MUST REVALIDATE TOO, because the document names the BUILD.
	//
	// The rule above deliberately covers the soft routes, which are is_404() to WP. `/`, `/about/`
	// and the rest are REAL pages, so they were already edge-cacheable and were left alone — but
	// "cacheable" here meant no Cache-Control header at all, so the edge applied its own TTL to a
	// document that hard-codes this build's hashed asset filenames (aq_app_assets()).
	//
	// That is how a deploy stops arriving. Measured on production: the origin served
	// `index-DwWLkZsg.js` while the bare URL served `index-D1_oWDYH.js` from a cached document, and
	// a returning visitor booted the older SPA. It does not 404 and it never looks broken, because
	// hashed chunks are immutable and every chunk this site has ever built is still on disk — so the
	// stale document finds exactly the stale code it asks for and runs it. The symptom surfaces much
	// later and somewhere else: a bug fixed weeks ago, still on screen, with the fix provably
	// deployed. (It is also why the asset directory only ever grows.)
	//
	// So: still cacheable at the edge — these are the busiest public pages and re-executing
	// WordPress for each view is what the rule above exists to avoid — but revalidated, so the
	// window between a deploy and the document that points at it is a minute, not a TTL nobody set.
	// Signed-out only, for the same reason as above: the shell injects window.AQ_USER and a nonce,
	// so a member's response must never be shared.
	if ( ! is_user_logged_in() && ! headers_sent() && ! is_admin() && ! is_feed()
		&& ! is_robots() && ( $_SERVER['REQUEST_METHOD'] ?? 'GET' ) === 'GET' ) {
		header_remove( 'Cache-Control' );
		header_remove( 'Pragma' );
		header_remove( 'Expires' );
		header( 'Cache-Control: public, max-age=0, s-maxage=60, must-revalidate' );
	}
}, 6 );

/**
 * Self-heal a React-route page: ensure a published WP page exists at $slug so the request resolves to
 * a 200 (served through the app template) instead of a 404 — both locally and after a deploy where no
 * migration created it. Idempotent + option-cached (aq_page_id_<slug>). The crawler/no-JS layer is
 * aq_app_route_seo($slug). Used for the renamed surfaces Topics/Grants (the live render targets) and
 * to keep the legacy Typology/Outreach pages published as stable 301 → /topics//grants/ anchors.
 */
function aq_ensure_app_page( $slug, $title ) {
	$opt = 'aq_page_id_' . str_replace( '-', '_', $slug );
	$id  = (int) get_option( $opt );
	if ( $id && 'page' === get_post_type( $id ) && 'publish' === get_post_status( $id ) ) {
		return;
	}
	$existing = get_page_by_path( $slug );
	if ( $existing instanceof WP_Post ) {
		update_option( $opt, (int) $existing->ID );
		return;
	}
	$new_id = wp_insert_post(
		array(
			'post_title'   => $title,
			'post_name'    => $slug,
			'post_status'  => 'publish',
			'post_type'    => 'page',
			'post_content' => '', // React owns the page; the crawler/no-JS layer is aq_app_route_seo($slug).
			'post_author'  => 1,
		)
	);
	if ( $new_id && ! is_wp_error( $new_id ) ) {
		// WP never fails on a taken slug — it quietly uniquifies to <slug>-2, -3, …. If that
		// happened, another request/process beat us to the canonical page (cold option cache +
		// concurrent traffic): KEEP that page and hard-delete our copy, or the duplicate stays
		// published, sitemapped, and indexed as a thin clone. Exactly this race minted
		// /fearometer-2/…/fearometer-34/ on prod (2026-06-08, Search Console ticket #59).
		$created = get_post( $new_id );
		if ( $created && $slug !== $created->post_name ) {
			wp_delete_post( $new_id, true );
			$canon = get_page_by_path( $slug );
			if ( $canon instanceof WP_Post ) {
				update_option( $opt, (int) $canon->ID );
			}
			return;
		}
		update_option( $opt, (int) $new_id );
	}
}
add_action(
	'init',
	function () {
		// The unified Explore hub (React: pages/Explore.tsx) — the cross-domain search front door.
		aq_ensure_app_page( 'explore', 'Explore' );
		// Renamed: Typology → Topics (2026-06-07) → Typologies (2026-07-10, the season wheel took /topics);
		// Outreach → Grants (2026-06-07) → Sponsors (2026-06-18). Topics (the wheel)/Typologies/Sponsors are
		// the live React render targets; the legacy Typology/Outreach/Grants/Skills pages stay published
		// only as the 301 anchors registered in the template_redirect block above.
		aq_ensure_app_page( 'topics', 'Topics' );
		aq_ensure_app_page( 'typologies', 'Typologies' );
		aq_ensure_app_page( 'why', 'Study cycles' ); // /why hub + per-cycle pages (/why/<slug>) — pages/Why.tsx
		// /professions (the house-axis Skills atlas) retired with the Skills-500 purge (2026-07-05):
		// its page stays published purely as the 301 anchor → /skills/ (template_redirect above).
		aq_ensure_app_page( 'skills', 'Topics' );
		aq_ensure_app_page( 'fields', 'Houses' ); // legacy /fields — 301 anchor → /skills/ (App.tsx redirects too)
		aq_ensure_app_page( 'cycles', 'Cycles' ); // /cycles — the celestial-cycle explanatory ranking — pages/Cycles.tsx
		aq_ensure_app_page( 'astro', 'ArtaAstro' ); // /astro PURGED 2026-07-07 — page stays published purely as the 301 anchor → /skills/ (world-event measures unified into the Topics atlas)
		// THE LIBRARY (operator 2026-07-28) — every published file, attachable to any member's post.
		// It needs a real page so /library/ resolves 200 with a canonical + crawler body, exactly
		// like every other app surface; without it the route fell through to the legacy redirect map.
		// /news/<slug> — one instrument detection. Needs a REAL published page even though every
		// URL under it is a soft route: without one, prod's redirect_guess_404_permalink resolves
		// the unknown top-level slug to whatever it thinks was meant, so the page 404s or 301s
		// away in production while working perfectly on localhost.
		aq_ensure_app_page( 'news', 'ArtaNews' );
		aq_ensure_app_page( 'library', 'Library' );
		aq_ensure_app_page( 'ceo', 'CEO' ); // the CEO posting (operator 2026-07-30) — pages/CeoRole.tsx
		aq_ensure_app_page( 'challenges', 'Challenges' ); // /challenges — member-founded challenges: entry fees fund the pool, winner takes all at the full moon — pages/ChallengesPage.tsx
		aq_ensure_app_page( 'competitions', 'Competitions' ); // /competitions — the Kaggle-style hosted-dataset arena — pages/Competitions.tsx (+ /competitions/new)
		aq_ensure_app_page( 'competition', 'Competition' ); // /competition?slug=<slug> — one competition's tabbed detail — pages/Competition.tsx
		aq_ensure_app_page( 'games', 'Games' ); // /games — the Games CATALOGUE (real, indexable); each game is /game/<slug>
		aq_ensure_app_page( 'research', 'Research' ); // /research — the sidereal trend atlas (weekly) — pages/Research.tsx
		aq_ensure_app_page( 'developers', 'Developers' ); // /developers — the API docs + token guide (author-only publish gate) — pages/Developers.tsx
		aq_ensure_app_page( 'artascience', 'ArtaScience' ); // /artascience — the reviewer transparency page (exact prompt) — pages/ArtaScience.tsx
		aq_ensure_app_page( 'artatranslate', 'ArtaTranslate' ); // /artatranslate — the translation-upgrade transparency page (adversarial rounds) — pages/ArtaTranslate.tsx
		aq_ensure_app_page( 'artaillustration', 'ArtaIllustration' ); // /artaillustration — the art-studio transparency page (exact prompts + live queue) — pages/ArtaIllustrationStudio.tsx
		aq_ensure_app_page( 'artasound', 'ArtaSound' ); // /artasound — 301 anchor → /music/ (the audio kind's own live hub, 2026-07-26)
		aq_ensure_app_page( 'sponsors', 'Sponsors' );
		aq_ensure_app_page( 'typology', 'Typology' );
		aq_ensure_app_page( 'outreach', 'Outreach' );
		aq_ensure_app_page( 'grants', 'Grants' );
		// Renamed 2026-06-11 (ticket #53): the lesson player moved to /video/?video=<id>. Video is
		// the live React render target; the legacy Lesson page stays published only as the 301
		// anchor registered in the template_redirect block above.
		aq_ensure_app_page( 'video', 'Video' );
		aq_ensure_app_page( 'lesson', 'Lesson' );
		// Offline / "take it with you" — the Download Center (React: pages/Offline.tsx).
		aq_ensure_app_page( 'offline', 'Offline downloads' );
		// Creator Studio — create + edit your courses (React: pages/Studio.tsx, 2026-06-12).
		aq_ensure_app_page( 'studio', 'Studio' );
		// Recommendations — purged 2026-06-24 (the daily "what to study now" now lives on Home only). The
		// slug stays published purely as the 301 anchor registered in the template_redirect block above.
		aq_ensure_app_page( 'recommendations', 'Recommendations' );
		// The Certificate of Participation — /certificate/?challenge=<id>, the holder's own copy
		// (pages/Participation.tsx). Its public half, /verify/, self-heals in aq_ensure_verify_page()
		// below; both need a real published page for the same reason, so heal both or the two halves
		// of one document drift apart on a fresh site. Noindex via aq_app_noindex_page_slugs().
		aq_ensure_app_page( 'certificate', 'Certificate of Participation' );
		// The Foundation's books — the double-entry general ledger, the invoice register with every
		// supporting PDF, and the year-end CRA package (React: pages/Finances.tsx, 2026-08-11).
		aq_ensure_app_page( 'finances', 'The Foundation\'s books' );
	},
	20
);

/**
 * Self-heal the /verify/ route. The public certificate-verification page is a React route that needs
 * a real published WP page at that slug so a verification link resolves to a 200 (served through the
 * app template) instead of a 404 — both locally and after a deploy where no migration created it.
 * Idempotent + option-cached so it costs nothing once the page exists. (Mirrors aq_ensure_app_page().)
 *
 * LOAD-BEARING, and the opposite of the 2026-08-04 bug: the page is what lets /verify/?p&u&k resolve
 * through is_page() with its query intact. What broke the route was the parse_request map above
 * claiming the slug at priority 1 — a redirect that fired before this page was ever consulted. Delete
 * this and a cold site falls back to is_404(), where WP's redirect_guess_404_permalink can hand the
 * URL to whatever slug it prefixes before the theme sees it (see /arta → /artaillustration/,
 * 2026-07-31). React renders the page from pages/Participation.tsx (Verify.tsx is no longer routed).
 */
function aq_ensure_verify_page() {
	$id = (int) get_option( 'aq_verify_page_id' );
	if ( $id && 'page' === get_post_type( $id ) && 'publish' === get_post_status( $id ) ) {
		return;
	}
	$existing = get_page_by_path( 'verify' );
	if ( $existing instanceof WP_Post ) {
		update_option( 'aq_verify_page_id', (int) $existing->ID );
		return;
	}
	$new_id = wp_insert_post(
		array(
			'post_title'   => 'Verify certificate',
			'post_name'    => 'verify',
			'post_status'  => 'publish',
			'post_type'    => 'page',
			'post_content' => '', // React owns the page (Verify.tsx); verification is noindex, no SEO body.
			'post_author'  => 1,
		)
	);
	if ( $new_id && ! is_wp_error( $new_id ) ) {
		// Slug-uniquify guard (see aq_ensure_app_page): never keep a verify-2 duplicate.
		$created = get_post( $new_id );
		if ( $created && 'verify' !== $created->post_name ) {
			wp_delete_post( $new_id, true );
			$canon = get_page_by_path( 'verify' );
			if ( $canon instanceof WP_Post ) {
				update_option( 'aq_verify_page_id', (int) $canon->ID );
			}
			return;
		}
		update_option( 'aq_verify_page_id', (int) $new_id );
	}
}
add_action( 'init', 'aq_ensure_verify_page', 20 );

/**
 * One-time index cleanup (Search Console, ticket #59). Two kinds of junk URL were published,
 * sitemapped, and indexable on prod:
 *   1. /fearometer-2/ … /fearometer-34/ — 33 empty duplicates of the ArtaMod page, minted on
 *      2026-06-08 when an older deploy raced the page self-heal (the slug-uniquify guards in
 *      aq_ensure_app_page / Fearometer::ensure_page now make that impossible). Each was a thin
 *      clone diluting the real /fearometer/ page.
 *   2. /hello-world-2/ — the stock WordPress sample post ("Welcome to WordPress! …") still
 *      published from the 2023 scaffold, advertised as the site's only blog post by
 *      wp-sitemap-posts-post-1.xml.
 * Trash (recoverable, not hard-delete): a trashed post leaves the sitemap immediately and its URL
 * returns a genuine 404 (noindex'd by the wp_robots filter above), so Google drops it cleanly.
 * Option-gated — one autoloaded read per request, runs once ever; the claim is written FIRST so
 * concurrent first-requests after the deploy can't double-run.
 */
add_action( 'init', function () {
	if ( get_option( 'aq_seo_index_cleanup' ) ) {
		return;
	}
	update_option( 'aq_seo_index_cleanup', 1, true );
	global $wpdb;
	$rows = $wpdb->get_results(
		"SELECT ID, post_name, post_title, post_content FROM {$wpdb->posts}
		  WHERE post_type = 'page' AND post_status = 'publish' AND post_name LIKE 'fearometer-%'"
	);
	foreach ( (array) $rows as $r ) {
		// Only the machine-minted shape — fearometer-<n>, a known self-heal title, empty body —
		// so a real future page that merely starts with "fearometer-" is never touched.
		if ( preg_match( '/^fearometer-\d+$/', (string) $r->post_name )
			&& in_array( $r->post_title, array( 'The Fearometer', 'ArtaMod' ), true )
			&& '' === trim( (string) $r->post_content ) ) {
			wp_trash_post( (int) $r->ID );
		}
	}
	$hw = get_page_by_path( 'hello-world-2', OBJECT, 'post' );
	if ( $hw && 'publish' === $hw->post_status && false !== strpos( (string) $hw->post_content, 'Welcome to WordPress' ) ) {
		wp_trash_post( $hw->ID );
	}
}, 30 );

add_shortcode(
	'aq_app',
	function () {
		// Mount point for the SPA (src/main.tsx mounts to #aq-app-root in prod).
		return '<div id="aq-app-root" class="aq-app-root"></div>';
	}
);

/**
 * Render the [aq_app] page through a bare full-viewport template (no theme
 * header/footer), so the SPA's own AppShell isn't wrapped in a second chrome.
 */
add_filter(
	'template_include',
	function ( $template ) {
		if ( aq_app_is_app_page() ) {
			$bare = get_theme_file_path( 'template-aq-app.php' );
			if ( file_exists( $bare ) ) {
				return $bare;
			}
		}
		return $template;
	}
);

// Note: the bare template (template-aq-app.php) prints the bundle + auth globals
// itself (resolved from aq_app_assets()), so there is no wp_enqueue_scripts hook —
// loading via wp_head would also pull WordPress's unlayered global styles, which
// would clobber the SPA's Tailwind @layer utilities.

/**
 * Keep the noindex private/transactional pages OUT of the XML sitemap — a sitemap must only list
 * INDEXABLE URLs; advertising pages we mark noindex is a conflicting crawl signal.
 */
add_filter( 'wp_sitemaps_posts_query_args', function ( $args, $post_type ) {
	if ( 'page' !== $post_type ) {
		return $args;
	}
	$ids = array();
	foreach ( aq_app_noindex_page_slugs() as $slug ) {
		$p = get_page_by_path( $slug );
		if ( $p ) {
			$ids[] = (int) $p->ID;
		}
	}
	// Redirecting URLs must be kept OUT of the sitemap (Search Console flags every one as
	// "Page with redirect" and won't index it): the legacy anchors and every pre-feed page
	// slug that now 301s in the parse_request feed map (2026-07-13) — see that map for the
	// targets. The 'games' page is excluded too, NOT because it redirects (it's the live games hub)
	// but because the aqhubs provider below advertises /games/ — listing it twice is a duplicate.
	foreach ( array(
		'typology', 'outreach', 'grants', 'almanac', 'recommendations', 'skills', 'fields',
		'professions', 'astro', 'lesson', 'video', 'app', 'checkout', 'checkout-3', 'my-account',
		'wishlist', 'courses', 'research', 'explore', 'discussions', 'typologies', 'why',
		'cycles', 'competitions', 'competition', 'artascience', 'artasound',
		'artatranslate', 'artaillustration', 'cart', 'games',
	) as $slug ) {
		$p = get_page_by_path( $slug );
		if ( $p ) {
			$ids[] = (int) $p->ID;
		}
	}
	if ( $ids ) {
		$args['post__not_in'] = array_merge( (array) ( $args['post__not_in'] ?? array() ), $ids );
	}
	return $args;
}, 10, 2 );

/**
 * Add the Notebook Feed to the XML sitemap (2026-07-13 redesign). The Feed front door
 * (/works/), the eleven kind hubs and every published notebook (/nb/<id>/<slug>/) are React soft routes
 * backed by aq_notebooks (NOT wp_posts), so WP's default sitemap (posts + pages only) misses them —
 * leaving the primary indexable content undiscoverable via the sitemap, search engines' main
 * discovery channel. They're fully indexable (real title/meta/JSON-LD/crawler body), so they belong.
 */
if ( class_exists( 'WP_Sitemaps_Provider' ) ) {
	// The static hub URLs → wp-sitemap-aqhubs-1.xml. Name must be HYPHEN-FREE: WP's sitemap URL is
	// wp-sitemap-{name}-{page}.xml, and a hyphen in the name collides with that separator
	// (wp-sitemap-aq-hubs-1.xml parses as provider "aq" → 404 → the SPA shell).
	class AQ_Sitemap_Hubs extends WP_Sitemaps_Provider {
		public function __construct() {
			$this->name        = 'aqhubs';
			$this->object_type = 'aqhub';
		}
		private function hubs() {
			$hubs = array( home_url( '/works/' ) );
			foreach ( array_keys( aq_feed_hubs() ) as $slug ) {
				$hubs[] = home_url( '/' . $slug . '/' );
			}
			return $hubs;
		}
		public function get_url_list( $page_num, $object_subtype = '' ) {
			if ( 1 !== (int) $page_num ) {
				return array();
			}
			return array_map( function ( $u ) {
				return array( 'loc' => $u );
			}, $this->hubs() );
		}
		public function get_max_num_pages( $object_subtype = '' ) {
			return 1; // 12 static URLs — always a single page
		}
	}
	// Published notebooks → wp-sitemap-aqnotebooks-*.xml. Guarded: the aq_notebooks table may not
	// exist yet on a cold site, so the provider reports 0 pages instead of running a failing query.
	class AQ_Sitemap_Notebooks extends WP_Sitemaps_Provider {
		public function __construct() {
			$this->name        = 'aqnotebooks';
			$this->object_type = 'aqnotebook';
		}
		private function table() {
			global $wpdb;
			static $ok = null;
			$t = $wpdb->prefix . 'aq_notebooks';
			if ( null === $ok ) {
				$ok = ( (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) ) === $t );
			}
			return $ok ? $t : '';
		}
		public function get_url_list( $page_num, $object_subtype = '' ) {
			$t = $this->table();
			if ( '' === $t ) {
				return array();
			}
			global $wpdb;
			$per  = wp_sitemaps_get_max_urls( $this->object_type );
			$rows = $wpdb->get_results( $wpdb->prepare(
				"SELECT id, slug, published_at FROM {$t} WHERE status = 'published' ORDER BY id ASC LIMIT %d OFFSET %d",
				$per,
				( $page_num - 1 ) * $per
			) );
			return array_map( function ( $r ) {
				$e  = array( 'loc' => aq_notebook_url( $r ) );
				$ts = aq_notebook_published_ts( $r );
				if ( $ts ) { $e['lastmod'] = gmdate( 'c', $ts ); }
				return $e;
			}, $rows ?: array() );
		}
		public function get_max_num_pages( $object_subtype = '' ) {
			$t = $this->table();
			if ( '' === $t ) {
				return 0;
			}
			global $wpdb;
			$total = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE status = 'published'" ); // phpcs:ignore WordPress.DB.PreparedSQL -- table name from a fixed prefix, no user input
			// NO max(1,…) floor: an empty provider must report 0 pages so the sitemap INDEX stops
			// advertising it. WP core 404s an empty sitemap page, and is_404() hands that URL to the
			// SPA shell — so the index pointed Google at an HTML page where XML was promised
			// ("Sitemap could not be read").
			return (int) ceil( $total / wp_sitemaps_get_max_urls( $this->object_type ) );
		}
	}
	add_action( 'init', function () {
		wp_register_sitemap_provider( 'aqhubs', new AQ_Sitemap_Hubs() );
		wp_register_sitemap_provider( 'aqnotebooks', new AQ_Sitemap_Notebooks() );
	} );

	/**
	 * Generic sitemap provider for our lean aq_* content (threads, lessons, member profiles). These
	 * live in aq_* tables / the users table, not wp_posts, so WP's default sitemap misses them. Each
	 * is real, indexable content (forum posts, video lessons with VideoObject schema, public
	 * profiles), so they belong in the sitemap — search engines' primary discovery channel. One
	 * configurable class instead of three near-identical ones (lean over additive).
	 */
	class AQ_Sitemap_Query extends WP_Sitemaps_Provider {
		private $count_sql;
		private $page_sql;
		private $map;
		public function __construct( $name, $count_sql, $page_sql, callable $map ) {
			$this->name        = $name; // hyphen-free (URL is wp-sitemap-{name}-{page}.xml)
			$this->object_type = $name;
			$this->count_sql   = $count_sql;
			$this->page_sql    = $page_sql;
			$this->map         = $map;
		}
		public function get_url_list( $page_num, $object_subtype = '' ) {
			global $wpdb;
			$per  = wp_sitemaps_get_max_urls( $this->object_type );
			$rows = $wpdb->get_results( $wpdb->prepare( $this->page_sql, $per, ( $page_num - 1 ) * $per ) ); // phpcs:ignore WordPress.DB.PreparedSQL
			return array_values( array_filter( array_map( $this->map, $rows ?: array() ) ) );
		}
		public function get_max_num_pages( $object_subtype = '' ) {
			global $wpdb;
			$total = (int) $wpdb->get_var( $this->count_sql ); // phpcs:ignore WordPress.DB.PreparedSQL
			// 0 pages when empty — see AQ_Sitemap_Courses: a floored "page 1" with no URLs is 404'd
			// by core into the SPA shell, breaking the sitemap index entry it was advertised in.
			return (int) ceil( $total / wp_sitemaps_get_max_urls( $this->object_type ) );
		}
	}

	add_action( 'init', function () {
		global $wpdb;
		$p = $wpdb->prefix;
		// (aqthreads REMOVED 2026-07-27. The standalone forum was retired 2026-07-14 — see the
		// redirect map above, 'discussions' => '/works/' — so every URL this provider emitted
		// (/discussions/?forum=…&thread=…) 301s to /works/, and there is no surviving URL form
		// that serves a thread. It advertised 7 redirecting URLs to Google, which is exactly what
		// the note below says a sitemap must never do; it was simply missed when the other
		// retired providers were dropped. The aq_threads ROWS are untouched — this only stops
		// the sitemap claiming they are crawlable pages.)
		// Member profiles — only members who have actually contributed, so the sitemap stays
		// high-quality instead of listing every empty account as thin content. That intent is
		// unchanged; what counted as contributing was not.
		//
		// It asked `aq_comments WHERE context_type = 'section'` — a section-board reply, on the
		// courses platform purged 2026-07-13. That surface has had ZERO rows since, so the provider
		// counted zero members, reported zero pages, and dropped out of the sitemap index entirely.
		// No profile has been submitted to a search engine since the purge, and nothing said so: an
		// empty provider is indistinguishable from a healthy one that has nothing to offer yet.
		//
		// Contributing now means PUBLISHING A WORK, which is the act this platform is built around
		// and a deliberate, email-confirmed decision by the member to appear here publicly. It is
		// also what makes their profile worth reading — the page lists those works.
		wp_register_sitemap_provider( 'aqmembers', new AQ_Sitemap_Query(
			'aqmembers',
			"SELECT COUNT(DISTINCT author_id) FROM {$p}aq_notebooks WHERE status = 'published'",
			"SELECT u.user_nicename AS slug, MAX( n.published_at ) AS last_pub
			   FROM {$p}users u JOIN {$p}aq_notebooks n ON n.author_id = u.ID
			  WHERE n.status = 'published'
			  GROUP BY u.ID, u.user_nicename
			  ORDER BY u.ID ASC LIMIT %d OFFSET %d",
			function ( $r ) {
				if ( empty( $r->slug ) ) { return null; }
				$e = array( 'loc' => home_url( '/u/' . $r->slug . '/' ) );
				// Through aq_notebook_published_ts(), not strtotime(): published_at holds EITHER a
				// unix timestamp or a datetime string, and strtotime() on the numeric form does not
				// fail, it returns a wrong date — a bare year. Caught by testing the emitted lastmod
				// rather than the query. That helper is the one place that knows both shapes.
				$ts = aq_notebook_published_ts( (object) array( 'published_at' => $r->last_pub ?? '' ) );
				if ( $ts ) { $e['lastmod'] = gmdate( 'c', $ts ); }
				return $e;
			}
		) );
		// (The pre-feed providers — aqcourses/aqtopics/aqlessons/aqarticles/aqbooks/aqtracks/
		// aqanimations/aqfilms/aqillustrations/aqcomps — left with the 2026-07-13 redesign: their URL
		// sets 301 now, and a sitemap must never advertise redirecting URLs. Their replacements are
		// aqhubs + aqnotebooks above.)
	} );
}
