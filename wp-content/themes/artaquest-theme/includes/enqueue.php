<?php
// phpcs:ignoreFile

if ( ! function_exists( 'starter_styles_and_scripts' ) && ! is_admin() ) {
	function starter_styles_and_scripts() {

		/*Styles*/
		wp_enqueue_style( 'starter-style', get_stylesheet_uri(), array(), STM_THEME_VERSION );
		wp_enqueue_style( 'starter-base', STM_TEMPLATE_URI . '/assets/css/style.css', array(), STM_THEME_VERSION );
		wp_enqueue_style( 'google-fonts', starter_theme_fonts(), array(), STM_THEME_VERSION );

		wp_add_inline_style( 'starter-style', starter_color_styles() );

		wp_register_style( 'starter-404', STM_TEMPLATE_URI . '/assets/css/components/pages/404.css', array(), STM_THEME_VERSION );
		wp_register_style( 'starter-navigation', STM_TEMPLATE_URI . '/assets/css/components/header/navigation.css', array(), STM_THEME_VERSION );
		wp_enqueue_script( 'starter-header', STM_TEMPLATE_URI . '/assets/js/components/header/header.js', array( 'jquery' ), STM_THEME_VERSION, true );
		wp_enqueue_style( 'starter-navigation' );
		wp_register_style( 'starter-single-post', STM_TEMPLATE_URI . '/assets/css/components/post/single/single-post.css', array(), STM_THEME_VERSION );
		wp_register_style( 'starter-posts-list', STM_TEMPLATE_URI . '/assets/css/components/post/archive/posts-list.css', array(), STM_THEME_VERSION );
		wp_register_style( 'starter-search-list', STM_TEMPLATE_URI . '/assets/css/components/pages/search.css', array(), STM_THEME_VERSION );

		wp_enqueue_style( 'starter-icons', STM_TEMPLATE_URI . '/assets/fonts/ms/style.css', array(), STM_THEME_VERSION );

		if ( is_single() ) {
			wp_enqueue_style( 'starter-single-post' );
		}

		if ( ( is_archive() || is_author() || is_category() || is_tag() || is_home() ) && 'post' === get_post_type() ) {
			wp_enqueue_style( 'starter-posts-list' );
		}

		if ( is_search() ) {
			wp_enqueue_style( 'starter-search-list' );
		}

		if ( is_404() ) {
			wp_enqueue_style( 'starter-404' );
		}

	}

	add_action( 'wp_enqueue_scripts', 'starter_styles_and_scripts' );
}

// ArtaQuest fork — the vendor's admin-side dashboard (Freemius checkout,
// wizard, plugin installer, demo importer, child-theme creator) was deleted
// from /includes/dashboard/. All its asset-registration calls live below as
// stubs to prevent fatals if any third-party plugin tries to enqueue them.
function artaquest_starter_admin_register_script_styles() {
	// no-op — assets gone.
}
add_action( 'admin_enqueue_scripts', 'artaquest_starter_admin_register_script_styles' );

if ( ! function_exists( 'starter_move_jquery_into_footer' ) ) {
	function starter_move_jquery_into_footer( $wp_scripts ) {

		if ( is_admin() ) {
			return;
		}

		$wp_scripts->add_data( 'jquery', 'group', 1 );
		$wp_scripts->add_data( 'jquery-core', 'group', 1 );
		$wp_scripts->add_data( 'jquery-migrate', 'group', 1 );
	}
}

add_action( 'wp_default_scripts', 'starter_move_jquery_into_footer' );
// [REMOVED 2026-06-07] ms_lms_starter_generate_theme_option_css() emitted wp_head <style> for the
// .ms_lms_loader preloader spinner (customizer colours). The preloader subsystem was retired (commit
// 9e77491) — that markup is never emitted now, so the styling was orphaned (and already output nothing
// since the colour theme-mod is unset).
