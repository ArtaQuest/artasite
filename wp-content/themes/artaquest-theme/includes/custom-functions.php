<?php
/**
 * Content width
 */
if ( ! isset( $content_width ) ) {
	$content_width = 900;
}

/**
 * Favicon — SVG (modern browsers) + PNG fallbacks + Apple touch icon.
 *
 * iter-368 (user 2026-05-27): emit our icons FIRST in the head (priority 1) so
 * browsers prefer them over wp.com Atomic's auto-injected `s0.wp.com/i/webclip.png`
 * default. Also drop the `has_site_icon()` guard — wp.com filters has_site_icon
 * to return true regardless of the option value, which would otherwise hide our
 * PNG fallbacks. Belt-and-braces: also strip wp.com's webclip <link> tags by
 * filtering the head output.
 */
function starter_get_favicon() {
	$base = esc_url( get_template_directory_uri() . '/assets' );
	// Cache-bust against wp.com's edge CDN — append the theme version so a
	// favicon refresh on deploy is picked up immediately by every browser.
	$ver  = '?v=' . esc_attr( wp_get_theme()->get( 'Version' ) );
	// 180×180 PNG declared as rel="icon" FIRST: Google Search requires ≥48×48 px
	// for favicon display in results; the 32×32 falls below that threshold, and
	// SVG support in Google's favicon pipeline is inconsistent. Listing the large
	// PNG as the primary icon ensures Google picks a reliably-sized raster image.
	echo '<link rel="icon" type="image/png" sizes="180x180" href="' . $base . '/favicon-180.png' . $ver . '">' . "\n";
	// SVG for modern browsers (they resolve by type, not order).
	echo '<link rel="icon" type="image/svg+xml" href="' . $base . '/favicon.svg' . $ver . '">' . "\n";
	// 32×32 PNG fallback for older browsers.
	echo '<link rel="icon" type="image/png" sizes="32x32"  href="' . $base . '/favicon-32.png' . $ver . '">' . "\n";
	echo '<link rel="apple-touch-icon" sizes="180x180" href="' . $base . '/favicon-180.png' . $ver . '">' . "\n";
}
add_action( 'wp_head', 'starter_get_favicon', 1 );

/**
 * Strip wp.com's auto-injected default favicon (`s0.wp.com/i/webclip.png`)
 * from the head — it overrides our brand mark in browsers that prefer the
 * largest sized icon. Hook fires at the end of wp_head, scrubbing the
 * already-emitted markup via an output buffer.
 */
add_action( 'wp_head', function () {
	ob_start( function ( $html ) {
		// Strip BOTH the <link rel="icon" ... webclip.png> tags AND the
		// <meta name="msapplication-TileImage" content=".../webclip.png">
		// pinned-tile fallback that wp.com Atomic injects.
		return preg_replace(
			array(
				'#<link[^>]*s0\.wp\.com/i/webclip\.png[^>]*>\s*#i',
				'#<meta[^>]*s0\.wp\.com/i/webclip\.png[^>]*>\s*#i',
			),
			'',
			$html
		);
	} );
}, 0 );
add_action( 'wp_head', function () {
	if ( ob_get_level() > 0 ) {
		@ob_end_flush();
	}
}, 99 );

/**
 * Setup settings
 */
if ( ! function_exists( 'starter_setup' ) ) {
	function starter_setup() {
		load_theme_textdomain( 'starter-text-domain', get_template_directory() . '/languages' );
		add_theme_support( 'widgets' );
		add_theme_support( 'automatic-feed-links' );
		add_theme_support( 'title-tag' );
		add_theme_support( 'post-thumbnails' );
		add_theme_support( 'editor-styles' );
		add_theme_support( 'wp-block-styles' );
		add_theme_support( 'align-wide' );
		add_theme_support(
			'html5',
			array(
				'search-form',
				'comment-form',
				'comment-list',
				'gallery',
				'caption',
			)
		);

		register_nav_menus(
			array(
				'ms-lms-starter-theme-main-menu' => esc_html__( 'Header menu', 'starter-text-domain' ),
			)
		);
	}
}

add_action( 'after_setup_theme', 'starter_setup' );

/**
 * Add ping back url
 */
function starter_pingback_header() {
	if ( is_singular() && pings_open() ) {
		printf( '<link rel="pingback" href="%s">', esc_url( get_bloginfo( 'pingback_url' ) ) );
	}
}

add_action( 'wp_head', 'starter_pingback_header' );

/**
 * Custom excerpt size
 */
function starter_minimize_word( $word, $length = '40', $affix = '...' ) {
	if ( ! empty( intval( $length ) ) ) {
		$word_length = mb_strlen( $word );
		if ( $word_length > $length ) {
			$word = mb_strimwidth( $word, 0, $length, $affix );
		}
	}

	return sanitize_text_field( $word );
}

function starter_stored_theme_options() {
	$options = get_option( 'stm_theme_settings', array() );
	return apply_filters( 'starter_stored_theme_options', $options );
}

function starter_get_option( $option_name, $default = false ) {
	$options = starter_stored_theme_options();
	$option  = null;

	if ( ! empty( $options[ $option_name ] ) ) {
		$option = $options[ $option_name ];
	} elseif ( isset( $default ) ) {
		$option = $default;
	}

	return $option;
}

function starter_read_more_link() {
	if ( ! is_admin() ) {
		return '<a href="' . esc_url( get_permalink() ) . '" class="more-link"><span class="screen-reader-text">' . esc_html( get_the_title() ) . '</span></a>';
	}
}

add_filter( 'excerpt_more', 'starter_read_more_link' );

function starter_admin_bar_css() {
	?>
	<style type="text/css" media="screen">
		body { margin-top: 32px !important; }
		@media screen and (max-width: 782px) { body { margin-top: 46px !important; } }
	</style>
	<?php
}

add_theme_support( 'admin-bar', array( 'callback' => 'starter_admin_bar_css' ) );

function starter_widgets_init() {
	register_sidebar(
		array(
			'name'          => esc_html__( 'Primary sidebar', 'starter-text-domain' ),
			'id'            => 'primary-sidebar',
			'description'   => esc_html__( 'Add widgets here.', 'starter-text-domain' ),
			'before_widget' => '<section id="%1$s" class="widget widget-container %2$s">',
			'after_widget'  => '</section>',
			'before_title'  => '<h2 class="widget-title">',
			'after_title'   => '</h2>',
		)
	);
}

add_action( 'widgets_init', 'starter_widgets_init' );

/**
 * Custom Pagination
 */
if ( ! function_exists( 'posts_pages_pagination' ) ) :
	function posts_pages_pagination( $paging_extra_class = '', $current_query = '' ) {
		global $wp_query, $wp_rewrite;

		if ( ! $current_query ) {
			$paged = get_query_var( 'paged' ) ? intval( get_query_var( 'paged' ) ) : 1;
			$pages = $wp_query->max_num_pages;
		} else {
			$paged = $current_query->query_vars['paged'];
			$pages = $current_query->max_num_pages;
		}

		if ( $pages < 2 ) {
			return;
		}

		$page_num_link = html_entity_decode( get_pagenum_link() );
		$query_args    = array();
		$url_parts     = explode( '?', $page_num_link );

		if ( isset( $url_parts[1] ) ) {
			wp_parse_str( $url_parts[1], $query_args );
		}

		$page_num_link = remove_query_arg( array_keys( $query_args ), $page_num_link );
		$page_num_link = trailingslashit( $page_num_link ) . '%_%';

		$format  = $wp_rewrite->using_index_permalinks() && ! strpos( $page_num_link, 'index.php' ) ? 'index.php/' : '';
		$format .= $wp_rewrite->using_permalinks() ? user_trailingslashit( $wp_rewrite->pagination_base . '/%#%', 'paged' ) : '?paged=%#%';

		$links = paginate_links(
			array(
				'base'      => $page_num_link,
				'format'    => $format,
				'total'     => $pages,
				'current'   => $paged,
				'mid_size'  => 1,
				'add_args'  => array_map( 'urlencode', $query_args ),
				'prev_text' => '<span class="ms-lms-icon-arrow-left"></span>',
				'next_text' => '<span class="ms-lms-icon-arrow-right"></span>',
				'type'      => 'list',
			)
		);

		if ( $links ) {
			echo wp_kses_post( $links );
		}
	}
endif;

// MegaMenu removed 2026-06-05: the original MasterStudy starter-theme mega-menu (admin UI + nav
// walker + FontAwesome + frontend assets) is superseded by the React AppShell nav. Its frontend
// assets were already dequeued; nothing outside includes/megamenu/ called any of its functions.

// [REMOVED 2026-06-07] starter_theme_nonces() emitted admin_head nonces for the deleted MasterStudy
// updater (stm_update_starter_theme) + the dead starter_lms_settings_save action. No JS reads the
// starter_theme_nonces var; both actions are gone — orphaned.

add_filter( 'body_class', 'ms_lms_starter_body_classes' );
function ms_lms_starter_body_classes( $classes ) {
	$classes[] = 'theme-ms-lms-starter-theme';

	if ( has_blocks() && is_front_page() ) {
		$classes[] = 'ms-lms-guteberg-block-page';
	}

	return $classes;
}

/**
 * Custom avatar: serve a user's own `aq_avatar_url` (set on their profile) instead of the gravatar
 * mystery silhouette. Applies to every `get_avatar()` / `get_avatar_url()` call site (the plugin's
 * profile/leaderboard/discussion responses all go through core's avatar API, which fires this filter).
 *
 * PRESERVED from the retired legacy include aq-bug-bounty.php (which was superseded by the plugin's
 * ticket system but still carried this one live filter). Kept here so custom avatars don't regress;
 * it belongs with the plugin once avatar handling is consolidated there.
 */
add_filter( 'pre_get_avatar_data', function ( $args, $id_or_email ) {
	// Resolve the user from the various forms WP passes (user, ID, email, comment).
	$user_id = 0;
	if ( is_numeric( $id_or_email ) ) {
		$user_id = (int) $id_or_email;
	} elseif ( $id_or_email instanceof WP_User ) {
		$user_id = (int) $id_or_email->ID;
	} elseif ( is_object( $id_or_email ) && isset( $id_or_email->user_id ) ) {
		$user_id = (int) $id_or_email->user_id;
	} elseif ( is_object( $id_or_email ) && isset( $id_or_email->comment_author_email ) ) {
		$u = get_user_by( 'email', $id_or_email->comment_author_email );
		if ( $u ) { $user_id = (int) $u->ID; }
	} elseif ( is_string( $id_or_email ) && strpos( $id_or_email, '@' ) ) {
		$u = get_user_by( 'email', $id_or_email );
		if ( $u ) { $user_id = (int) $u->ID; }
	}
	if ( $user_id > 0 ) {
		$url = (string) get_user_meta( $user_id, 'aq_avatar_url', true );
		if ( $url !== '' && filter_var( $url, FILTER_VALIDATE_URL ) ) {
			$args['url']          = $url;
			$args['found_avatar'] = true;
		}
	}
	return $args;
}, 10, 2 );
