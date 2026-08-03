<?php
wp_enqueue_style( 'ms_lms_courses_searchbox' );
wp_enqueue_script( 'ms_lms_courses_searchbox_autocomplete' );
wp_enqueue_script( 'ms_lms_courses_searchbox' );

$search_options = array(
	'presets'            => get_theme_mod( 'ms_lms_starter_search_presets' ),
	'popup'              => get_theme_mod( 'ms_lms_starter_search_popup', true ),
	'popup_presets'      => get_theme_mod( 'ms_lms_starter_search_popup_presets', 'without_wrapper' ),
	'categories'         => get_theme_mod( 'ms_lms_starter_search_category' ),
	'search_placeholder' => get_theme_mod( 'ms_lms_starter__search_placeholder' ),
);

$search_button_bg                  = get_theme_mod( 'ms_lms_starter_search_button_bg' ) ? get_theme_mod( 'ms_lms_starter_search_button_bg' ) : '#227AFF';
$search_button_color               = get_theme_mod( 'ms_lms_starter_search_button_color' ) ? get_theme_mod( 'ms_lms_starter_search_button_color' ) : '#ffffff';
$search_category_button_color      = get_theme_mod( 'ms_lms_starter_search_category_button_color' ) ? get_theme_mod( 'ms_lms_starter_search_category_button_color' ) : '#4D5E6F';
$search_category_button_bg_color   = get_theme_mod( 'ms_lms_starter_search_category_button_bg_color' ) ? get_theme_mod( 'ms_lms_starter_search_category_button_bg_color' ) : '#EEF1F7';
$search_category_dropdown_color    = get_theme_mod( 'ms_lms_starter_search_category_dropdown_color' ) ? get_theme_mod( 'ms_lms_starter_search_category_dropdown_color' ) : '#ffffff';
$search_category_dropdown_bg_color = get_theme_mod( 'ms_lms_starter_search_category_dropdown_bg_color' ) ? get_theme_mod( 'ms_lms_starter_search_category_dropdown_bg_color' ) : '#227AFF';
?>
<style>
:root {
	--stm-lms-search-button-bg: <?php echo esc_attr( $search_button_bg ); ?>;
	--stm-lms-search-button-color: <?php echo esc_attr( $search_button_color ); ?>;
	--stm-lms-search-category-button-color: <?php echo esc_attr( $search_category_button_color ); ?>;
	--stm-lms-search-category-button-bg-color: <?php echo esc_attr( $search_category_button_bg_color ); ?>;
	--stm-lms-search-category-dropdown-color: <?php echo esc_attr( $search_category_dropdown_color ); ?>;
	--stm-lms-search-category-dropdown-bg-color: <?php echo esc_attr( $search_category_dropdown_bg_color ); ?>;
}
</style>
<div class="stm_lms_courses_search">
	<?php \STM_LMS_Templates::show_lms_template( 'elementor-widgets/courses-searchbox/ms-lms-courses-searchbox', $search_options ); ?>
</div>
