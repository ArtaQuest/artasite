<?php
/**
 * Self-contained full-viewport host for the React front-end (all surfaces).
 *
 * React owns the entire front-end; this template serves only the "necessary SEO
 * content": the route's schema.org JSON-LD + a server-rendered content fallback
 * inside #aq-app-root (crawler + no-JS layer), which React renders over on load.
 *
 * It deliberately does NOT call the full wp_head(): WordPress prints its global +
 * block + theme styles UNLAYERED, which beat Tailwind's @layer utilities and clobber
 * the SPA layout. Instead it CAPTURES wp_head and emits only the JSON-LD <script>
 * blocks (the per-route schema emitters already hook wp_head) — schema, no CSS.
 * Selected by the template_include filter in includes/aq-app.php.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
$aq_app   = function_exists( 'aq_app_assets' ) ? aq_app_assets() : array( 'js' => '', 'css' => array() );
$aq_nonce = wp_create_nonce( 'wp_rest' );
$aq_rest  = esc_url_raw( rest_url() );
// Google sign-in client id for the React button. Read the SAME option the plugin's AQ\Auth::google
// verifies against (the client id is public, so it lives in an option, not Secrets) — so the front-end
// and back-end can never disagree on which client id is in play.
// Same source as Auth::google() verifies against (Vault first, option as fallback). These two
// MUST agree: the button mints an ID token for whichever client id is injected here, and the
// server compares its `aud` against its own copy — so a mismatch fails every sign-in silently.
$aq_google_cid = class_exists( '\AQ\Secrets' ) ? trim( (string) \AQ\Secrets::get( 'GOOGLE_OAUTH_CLIENT_ID' ) ) : '';
if ( '' === $aq_google_cid ) { $aq_google_cid = (string) get_option( 'aq_google_client_id', '' ); }
$aq_dash  = function_exists( 'aq_app_is_dashboard' ) && aq_app_is_dashboard();
$aq_seo   = function_exists( 'aq_app_seo_html' ) ? aq_app_seo_html() : '';

// Server-render an ACCEPTED journal article's full text into the page body (crawler + no-JS layer; React
// clears #aq-app-root on mount, so there is no hydration-mismatch concern). Null resolver / non-accepted /
// zero submissions → empty string → nothing rendered. Built here so the body markup below stays clean.
$aq_article = '';
$aq_submission = function_exists( 'aq_app_current_submission' ) ? aq_app_current_submission() : null;
if ( $aq_submission ) {
	$aq_sa_author = get_userdata( (int) $aq_submission->author_id );
	$aq_sa_name   = ( $aq_sa_author && '' !== $aq_sa_author->display_name ) ? $aq_sa_author->display_name : 'ArtaQuest';
	$aq_sa_date   = ! empty( $aq_submission->created ) ? gmdate( 'F Y', (int) $aq_submission->created ) : gmdate( 'F Y' );
	$aq_sa_doi    = trim( (string) $aq_submission->doi );

	$aq_article  = '<article class="aq-ssr-article" style="max-width:46rem;margin:0 auto;padding:2rem 1rem">';
	$aq_article .= '<header>';
	$aq_article .= '<p class="aq-ssr-eyebrow">Journal of Seasonality</p>';
	$aq_article .= '<h1>' . esc_html( (string) $aq_submission->title ) . '</h1>';
	$aq_article .= '<p class="aq-ssr-meta">' . esc_html( $aq_sa_name ) . ' · ' . esc_html( $aq_sa_date ) . ' · Open access (CC BY 4.0)';
	if ( '' !== $aq_sa_doi ) {
		$aq_doi_url  = 'https://doi.org/' . ltrim( $aq_sa_doi, '/' );
		$aq_article .= ' · <a href="' . esc_url( $aq_doi_url ) . '">' . esc_html( $aq_sa_doi ) . '</a>';
	}
	$aq_article .= '</p></header>';

	$aq_article .= '<h2>Abstract</h2>';
	$aq_article .= '<p>' . esc_html( (string) $aq_submission->abstract ) . '</p>';

	// Re-sanitise body_html on output (mirrors AQ\Science::clean_body_html's allowlist + protocols), then
	// strip base64 data-URI <img> to keep the SSR page lean (the SPA/PDF show the figures; crawlers index
	// the text + <figcaption> captions, which remain).
	$aq_body = (string) $aq_submission->body_html;
	if ( '' !== trim( $aq_body ) ) {
		$aq_body_allowed = array(
			'h2' => array( 'id' => true ), 'h3' => array( 'id' => true ), 'h4' => array( 'id' => true ),
			'p' => array( 'class' => true ), 'br' => array(), 'hr' => array(),
			'em' => array(), 'strong' => array(), 'b' => array(), 'i' => array(), 'sup' => array( 'id' => true ), 'sub' => array(), 'small' => array(),
			'code' => array(), 'pre' => array(), 'kbd' => array(), 'abbr' => array( 'title' => true ),
			'ul' => array(), 'ol' => array( 'start' => true ), 'li' => array( 'id' => true ), 'dl' => array(), 'dt' => array(), 'dd' => array(),
			'blockquote' => array( 'cite' => true ), 'section' => array( 'id' => true, 'class' => true ),
			'a' => array( 'href' => true, 'title' => true, 'id' => true ), 'span' => array( 'class' => true, 'id' => true ),
			'figure' => array( 'id' => true ), 'figcaption' => array(),
			'table' => array(), 'thead' => array(), 'tbody' => array(), 'tfoot' => array(), 'tr' => array(),
			'th' => array( 'colspan' => true, 'rowspan' => true, 'scope' => true ), 'td' => array( 'colspan' => true, 'rowspan' => true ), 'caption' => array(),
		);
		// Figures are the journal's interactive charts (client-rendered) — never raw <img>; strip them.
		$aq_body = wp_kses( $aq_body, $aq_body_allowed, array( 'https', 'http', 'mailto' ) );
		$aq_body = (string) preg_replace( '/<img\b[^>]*>/i', '', $aq_body );
		$aq_article .= $aq_body;
	}
	$aq_article .= '</article>';
}
// Lesson player URL is /courses/<slug>/<lesson-id> (is_singular stm-courses + trailing id), or the
// stm-lessons singular. Extract the lesson id so React renders the player instead of the course detail.
$aq_lesson_id = is_singular( 'stm-lessons' ) ? (int) get_the_ID() : 0;
if ( ! $aq_lesson_id ) {
	$aq_req_path = (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ?? '' ), PHP_URL_PATH );
	if ( preg_match( '#/courses/[^/]+/(\d+)/?$#', $aq_req_path, $aq_lm ) ) { // /courses/<slug>/<lesson-id> player URL
		$aq_lesson_id = (int) $aq_lm[1];
	}
}

// Active-language registry for the React language switcher (artaquest-i18n). The
// SPA builds per-language switch URLs client-side from the live path; we only need
// the active codes + native labels + the current language here.
// Wrapped in try/catch so a theme/plugin VERSION MISMATCH (e.g. the theme is deployed ahead of the
// i18n plugin, so a class exists but a newly-added static method does not) degrades gracefully to the
// source language instead of fatalling the whole front end. Without this, a partial deploy takes the
// entire site down (every render calls these). class_exists alone is not enough — the methods can be
// new on a class that already exists.
// Language boot config comes from the artaquest plugin's i18n registry (AQ\I18n).
$aq_i18n     = null;
$aq_seo_i18n = null;
try {
	if ( class_exists( 'AQ\\I18n' ) ) {
		$aq_i18n = AQ\I18n::js_config();
	}
} catch ( \Throwable $aq_i18n_err ) {
	$aq_i18n = null; // i18n layer unavailable → render the source language
}

// Country/currency layer for the React selector + localized prices. The wp_head
// inline AQ_GEO is stripped below with all non-JSON-LD scripts, so emit it in the
// explicit config block (alongside AQ_I18N) where it survives.
$aq_geo = function_exists( 'aq_geo_js_config' ) ? aq_geo_js_config() : null;

// Capture wp_head and keep ONLY the JSON-LD (per-route schema.org) — drops the CSS
// that would otherwise clobber the SPA's Tailwind layers.
$aq_jsonld = '';
if ( ! $aq_dash ) {
	ob_start();
	do_action( 'wp_head' );
	$aq_head_html = (string) ob_get_clean();
	// Keep the per-route SEO that AQ_I18N_SEO + WP emit during wp_head — <meta>
	// (description / robots / og: / twitter:), <link rel=canonical / alternate hreflang>, and
	// JSON-LD — so the React routes are "fully visible" to crawlers and no-JS. Strip ONLY what
	// would clobber the SPA or duplicate what this template already emits: stylesheets, <style>,
	// scripts (except JSON-LD), the <title>, and favicon links.
	$aq_seo_head = preg_replace( '#<link\b[^>]*\brel=["\']?stylesheet["\']?[^>]*>#i', '', $aq_head_html );
	$aq_seo_head = preg_replace( '#<style\b[^>]*>.*?</style>#is', '', (string) $aq_seo_head );
	$aq_seo_head = preg_replace( '#<script\b(?![^>]*application/ld\+json)[^>]*>.*?</script>#is', '', (string) $aq_seo_head );
	$aq_seo_head = preg_replace( '#<title\b[^>]*>.*?</title>#is', '', (string) $aq_seo_head );
	$aq_seo_head = preg_replace( '#<link\b[^>]*\brel=["\']?(?:icon|apple-touch-icon|shortcut icon)["\']?[^>]*>#i', '', (string) $aq_seo_head );

	// THE WEBFONTS, RE-EMITTED HERE. The stylesheet strip above is deliberate — a theme stylesheet
	// would clobber the SPA — but it also removed the ONLY font link the site has (functions.php),
	// so on every SPA route Inter and Montserrat fell through to the OS font and the design system's
	// whole typographic identity was simply absent: `--font-display: Montserrat` resolving to
	// system-ui, and every letter-spacing value tuned for a face that never loaded. The built app CSS
	// ships no @font-face either (verified: zero), so nothing else was going to supply them.
	// Montserrat is requested here because functions.php never asked for it at all. The CSP already
	// allows fonts.googleapis.com in style-src and fonts.gstatic.com in font-src — the intent was
	// always for these to load.
	$aq_jsonld   = trim( (string) $aq_seo_head ); // full SEO head (meta + links + JSON-LD), emitted below
}
// wp_get_document_title() runs the document_title_parts filter (AQ_I18N_SEO::title_parts
// localises every part) and yields a descriptive "<Page> – <Site>" title. The old
// wp_title() path bypassed that filter, so titles were neither descriptive on the home
// nor translated on non-English locales.
$aq_title = $aq_dash ? get_bloginfo( 'name' ) : wp_get_document_title();
// Prefer the client-saved translated title for this URL+language when we have it.
if ( ! empty( $aq_seo_i18n['title'] ) ) {
	$aq_title = $aq_seo_i18n['title'];
}
?><!doctype html>
<?php
// Set lang/dir straight from the i18n router so every one of the ~130 languages
// renders with the correct direction on the first frame — independent of whether
// WordPress has a matching .mo loaded (most long-tail languages don't).
$aq_html_lang = $aq_i18n ? $aq_i18n['current'] : 'en';
$aq_html_dir  = ( $aq_i18n && 'rtl' === $aq_i18n['dir'] ) ? 'rtl' : 'ltr';
?>
<html lang="<?php echo esc_attr( $aq_html_lang ); ?>" dir="<?php echo esc_attr( $aq_html_dir ); ?>">
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
	<?php // PWA: installable + offline. The manifest + service worker are served at the site root by the
	// aquest plugin (AQ\Offline::serve_pwa_assets); the SW caches the app shell so the SPA boots with no
	// network, and the React offline layer (src/lib/offline) serves downloaded courses/data from IndexedDB. ?>
	<link rel="manifest" href="/manifest.webmanifest">
	<meta name="theme-color" content="#0d0d0f">
	<?php // Theme boot (ticket #44): set dark/light on <html> BEFORE first paint so there is never a
	// flash of the wrong theme. The visitor's saved choice (localStorage "aq_theme") wins; otherwise
	// anonymous visitors default to LIGHT (Kaggle-style) and signed-in members keep the dark cosmos.
	// Mirrors src/lib/theme.ts, which owns the toggle after the app mounts.
	// Also sets data-contrast (1..5) pre-paint from localStorage "aq_contrast" (else the ambient-biased
	// default: 3 at night, 4 by day) — this drives the precomputed contrast ramp in index.css so the
	// whole UI follows the member's contrast setting universally + flash-free. Mirrors src/lib/contrast.ts. ?>
	<script>(function(){var t=null;try{t=localStorage.getItem('aq_theme')}catch(e){}if(t!=='light'&&t!=='dark')t=<?php echo is_user_logged_in() ? "'dark'" : "'light'"; ?>;document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',t==='light'?'#f6f7f9':'#0d0d0f');var c=0;try{c=parseInt(localStorage.getItem('aq_contrast'),10)}catch(e){}if(!(c>=1&&c<=5)){try{if(matchMedia('(prefers-contrast:more)').matches)c=5;else if(matchMedia('(prefers-contrast:less)').matches)c=1;}catch(e){}}if(!(c>=1&&c<=5)){var h=new Date().getHours();c=(h<7||h>=21)?2:3;}document.documentElement.setAttribute('data-contrast',c);})()</script>
	<meta name="apple-mobile-web-app-capable" content="yes">
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
	<meta name="apple-mobile-web-app-title" content="ArtaQuest">
	<?php // Critical inline CSS: paint the themed canvas (space-1) on the FIRST frame, before the
	// hashed bundle CSS downloads — kills the flash of the wrong theme on a slow first load. The
	// html[data-theme=light] variants key off the attribute the boot script above just set. A branded
	// full-screen loader (#aq-boot-screen) sits ON TOP of #aq-app-root so the SEO fallback HTML
	// (kept in the DOM for crawlers) is never visible to people; React fades+removes it on mount. ?>
	<style>html{background:#0d0d0f}body{margin:0;background:#0d0d0f;color:#f4f4f5;font-family:Inter,ui-sans-serif,system-ui,sans-serif}html[data-theme=light],html[data-theme=light] body{background:#f6f7f9;color:#16181d}html[data-theme=light] #aq-boot-screen{background:#f6f7f9}html[data-theme=light] .aqb-bar{background:rgba(16,19,26,.1)}#aq-app-root{min-height:100vh}#aq-boot-screen{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;background:#0d0d0f;transition:opacity .35s ease}#aq-boot-screen.aqb-hide{opacity:0;pointer-events:none}.aqb-wrap{display:flex;flex-direction:column;align-items:center;gap:20px;animation:aqb-in .45s ease both}.aqb-mark{width:62px;height:62px;animation:aqb-pulse 1.9s ease-in-out infinite}.aqb-word{font-family:Montserrat,Inter,ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:27px;letter-spacing:-.02em;line-height:1}.aqb-bar{position:relative;width:150px;height:3px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}.aqb-bar i{position:absolute;top:0;bottom:0;width:42%;border-radius:999px;background:linear-gradient(90deg,#e8b923,#4a72ff);animation:aqb-slide 1.15s ease-in-out infinite}@keyframes aqb-slide{0%{left:-42%}100%{left:100%}}@keyframes aqb-pulse{0%,100%{opacity:.82;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}@keyframes aqb-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.aqb-mark,.aqb-bar i,.aqb-wrap{animation:none}}</style>
	<?php // Favicon — the SPA template captures+discards wp_head, so the brand mark
	// (emitted by starter_get_favicon on wp_head for classic pages) never reaches the
	// React pages. Emit it directly here so every SPA route shows the Aquest A-in-ring.
	// 180×180 PNG declared as rel="icon" first so Google Search picks a ≥48×48 raster
	// (the 32×32 alone falls below Google's minimum for favicon display in results). ?>
	<?php $aq_fav_v = '?v=' . wp_get_theme()->get( 'Version' ); ?>
	<link rel="icon" type="image/png" sizes="180x180" href="<?php echo esc_url( get_theme_file_uri( 'assets/favicon-180.png' ) . $aq_fav_v ); ?>">
	<link rel="icon" type="image/svg+xml" href="<?php echo esc_url( get_theme_file_uri( 'assets/favicon.svg' ) . $aq_fav_v ); ?>">
	<link rel="icon" type="image/png" sizes="32x32" href="<?php echo esc_url( get_theme_file_uri( 'assets/favicon-32.png' ) . $aq_fav_v ); ?>">
	<link rel="apple-touch-icon" sizes="180x180" href="<?php echo esc_url( get_theme_file_uri( 'assets/favicon-180.png' ) . $aq_fav_v ); ?>">
	<?php if ( $aq_dash ) : ?><meta name="robots" content="noindex"><?php endif; ?>
	<title><?php echo esc_html( $aq_title ); ?></title>
	<?php echo $aq_jsonld; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped — schema.org JSON-LD from wp_head emitters ?>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Montserrat:wght@600;700;800&amp;display=swap">
	<?php // The SPA's bundle CSS loads NON-render-blocking (preload → flip to stylesheet on load): the
	// branded #aq-boot-screen below — styled by the critical inline CSS above — covers the canvas until
	// React paints the route, so the stylesheet arriving a beat later is invisible, and the browser no
	// longer blocks first paint waiting on it (the render-blocking-request audit). <noscript> keeps it a
	// normal blocking stylesheet with JS off (crawlers / no-JS). The inline onload is allowed by our CSP
	// (script-src includes 'unsafe-inline'). ?>
	<?php foreach ( $aq_app['css'] as $css ) :
		$aq_css_href = esc_url( get_theme_file_uri( 'app/' . $css ) ); ?>
	<link rel="preload" as="style" href="<?php echo $aq_css_href; ?>" onload="this.onload=null;this.rel='stylesheet'">
	<noscript><link rel="stylesheet" href="<?php echo $aq_css_href; ?>"></noscript>
	<?php endforeach; ?>
	<script>window.AQ_MEDIA_CDN=<?php echo wp_json_encode( class_exists( '\AQ\Media' ) && \AQ\Media::r2_ready() ? \AQ\Media::cdn_base() : '' ); ?>;window.AQ_WP_NONCE=<?php echo wp_json_encode( $aq_nonce ); ?>;window.AQ_WP_REST=<?php echo wp_json_encode( $aq_rest ); ?>;window.AQ_LOGGED_IN=<?php echo is_user_logged_in() ? 'true' : 'false'; ?>;window.AQ_LOGOUT_URL=<?php echo wp_json_encode( wp_logout_url( home_url( '/' ) ) ); ?>;window.AQ_LOGIN_URL=<?php echo wp_json_encode( home_url( '/login/' ) ); ?>;window.AQ_GOOGLE_CLIENT_ID=<?php echo wp_json_encode( $aq_google_cid ); ?>;window.AQ_LESSON_ID=<?php echo (int) $aq_lesson_id; ?>;window.AQ_PAGE_ID=<?php echo is_page() ? (int) get_queried_object_id() : 0; ?>;window.AQ_IS_404=<?php echo is_404() ? 'true' : 'false'; ?>;window.AQ_I18N=<?php echo wp_json_encode( $aq_i18n ); ?>;window.AQ_GEO=<?php echo wp_json_encode( $aq_geo ); ?>;window.AQ_USER=<?php $aq_cu = wp_get_current_user(); echo wp_json_encode( ( $aq_cu && $aq_cu->ID ) ? array( 'id' => (int) $aq_cu->ID, 'name' => $aq_cu->display_name ? $aq_cu->display_name : $aq_cu->user_login, 'avatar' => class_exists( '\AQ\Verify' ) ? \AQ\Verify::avatar_url( $aq_cu->ID, 80 ) : get_avatar_url( $aq_cu->ID, array( 'size' => 80 ) ), 'slug' => $aq_cu->user_nicename, 'birthday' => class_exists( '\AQ\Verify' ) ? \AQ\Verify::birthday( $aq_cu->ID ) : '', 'birth_min' => class_exists( '\AQ\Verify' ) ? \AQ\Verify::birth_min( $aq_cu->ID ) : '', 'has_identity' => class_exists( '\AQ\Verify' ) ? \AQ\Verify::has_identity( $aq_cu->ID ) : true, 'season' => class_exists( '\AQ\Seasons' ) ? \AQ\Seasons::of_user( $aq_cu->ID ) : 0 ) : null ); ?>;window.AQ_LABELS=<?php echo wp_json_encode( array( 'houses' => (object) ( json_decode( (string) get_option( 'aq_house_labels', '{}' ), true ) ?: array() ), 'signs' => (object) ( json_decode( (string) get_option( 'aq_sign_labels', '{}' ), true ) ?: array() ) ) ); ?>;</script>
</head>
<body class="aq-app-body">
	<div id="aq-app-root"><?php
		// An accepted journal article's full text, server-rendered into the mount node so crawlers + no-JS
		// see the body (the SPA replaces it on mount). Empty unless this is /research/?submission=<accepted>.
		echo $aq_article; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped — masthead is esc_html/esc_url'd; body re-sanitised with wp_kses above
		// SEO fallback (crawler / no-JS) when present — kept in the DOM for crawlers but hidden
		// from people behind the branded loader below. React replaces it on mount.
		echo $aq_seo ? $aq_seo : ''; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped — server-rendered SEO fallback (shortcode/the_content, already sanitised)
	?></div>
	<?php // Branded first-paint loader — covers the canvas (and any SEO fallback) with the Aquest
	// A-in-ring mark + wordmark + an indeterminate gold→blue bar until React mounts and fades it
	// out. No JS needed to show it; main.tsx removes it once the app has painted. ?>
	<div id="aq-boot-screen" aria-hidden="true">
		<div class="aqb-wrap">
			<svg class="aqb-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
				<defs><mask id="aqbMask"><rect width="100" height="100" fill="#fff"/><path d="M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z" fill="#000" stroke="#000" stroke-width="7" stroke-linejoin="round"/></mask></defs>
				<circle cx="50" cy="50" r="41.6" fill="none" stroke="#4A72FF" stroke-width="11.66" mask="url(#aqbMask)"/>
				<path fill="#E8B923" fill-rule="evenodd" d="M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67ZM50 34.55L38.57 59.3L61.43 59.3Z"/>
			</svg>
			<div class="aqb-word"><span style="color:#e8b923">Arta</span><span style="color:#4a72ff">Quest</span></div>
			<div class="aqb-bar"><i></i></div>
		</div>
	</div>
	<?php
	// Client-side i18n is now owned by the React i18n engine (src/lib/i18n): it
	// collects every visible string, resolves known translations from the DB via
	// /aq/v1/i18n/resolve, translates the rest through Google (client-direct, with
	// a server proxy fallback), gates the first paint behind a translated loader so
	// no untranslated component is ever shown, then saves results + SEO back to the
	// DB for the next visitor. The config it needs is in window.AQ_I18N above.
	?>
	<?php if ( $aq_app['js'] ) : ?>
	<script type="module" src="<?php echo esc_url( get_theme_file_uri( 'app/' . $aq_app['js'] ) ); ?>"></script>
	<?php endif; ?>
</body>
</html>
