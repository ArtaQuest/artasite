<?php
$menu_args = array(
	'depth'          => 3,
	'container'      => false,
	'items_wrap'     => '%3$s',
	'fallback_cb'    => false,
	'theme_location' => 'ms-lms-starter-theme-main-menu',
);

// ArtaQuest fork — defaults aligned with the two-color brand styleguide.
// Original starter-theme defaults included a green (#61CE70) hover that
// violates the no-third-accent rule.
$menu_link_color       = get_theme_mod( 'ms_lms_starter_menu_link_color' ) ? get_theme_mod( 'ms_lms_starter_menu_link_color' ) : '#FFFFFF';
$menu_link_hover_color = get_theme_mod( 'ms_lms_starter_menu_link_hover_color' ) ? get_theme_mod( 'ms_lms_starter_menu_link_hover_color' ) : '#E8B923';
$menu_link_size        = get_theme_mod( 'ms_lms_starter_menu_link_size' ) ? get_theme_mod( 'ms_lms_starter_menu_link_size' ) : '15';
$menu_link_line_height = get_theme_mod( 'ms_lms_starter_menu_link_line_height' ) ? get_theme_mod( 'ms_lms_starter_menu_link_line_height' ) : '15';
$menu_link_font_weight = get_theme_mod( 'ms_lms_starter_menu_link_font_weight' ) ? get_theme_mod( 'ms_lms_starter_menu_link_font_weight' ) : '15';
$menu_separator_color  = get_theme_mod( 'ms_lms_starter_menu_separator_color' ) ? get_theme_mod( 'ms_lms_starter_menu_separator_color' ) : '#2352E8';
?>
<style>
	:root {
		--stm-lms-menu-link-color: <?php echo esc_attr( $menu_link_color ); ?>;
		--stm-lms-menu-link-hover-color: <?php echo esc_attr( $menu_link_hover_color ); ?>;
		--stm-lms-menu-link-size: <?php echo esc_attr( $menu_link_size ); ?>px;
		--stm-lms-menu-link-line-height: <?php echo esc_attr( $menu_link_line_height ); ?>px;
		--stm-lms-menu-link-font-weight: <?php echo esc_attr( $menu_link_font_weight ); ?>;
		--stm-lms-menu-separator-color: <?php echo esc_attr( $menu_separator_color ); ?>;
	}
</style>
<div class="navigation-menu">
	<ul class="starter-menu menu" id="aq-primary-nav">
		<?php wp_nav_menu( $menu_args ); ?>
	</ul>

	<button type="button" class="mobile-switcher" aria-label="<?php esc_attr_e( 'Open navigation menu', 'artaquest' ); ?>" aria-expanded="false" aria-haspopup="dialog" aria-controls="aq-drawer">
		<span aria-hidden="true"></span> <span aria-hidden="true"></span> <span aria-hidden="true"></span>
	</button>
</div>
