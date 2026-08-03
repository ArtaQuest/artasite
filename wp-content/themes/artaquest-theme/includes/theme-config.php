<?php

function starter_get_demo_name() {
	$demo_name = get_option( 'stm_demo_name', 'main_demo' );

	return $demo_name;
}

function starter_color_styles() {
	ob_start();
	?>
	:root {
		--container_width: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_container_width', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_container_width', '' ) . 'px' : '1200px' ); ?>;
		--primary_color: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_primary_color', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_primary_color', '' ) : '#303441' ); ?>;
		--accent_color: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_accent_color', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_accent_color', '' ) : '#385bce' ); ?>;
		--second_accent_color: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_accent_second_color', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_accent_second_color', '' ) : '#43C370' ); ?>;
		--body_font_family: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_body_font', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_body_font', '' ) : 'Open Sans' ); ?>;
		--body_font_size: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_body_font_size', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_body_font_size', '' ) . 'px' : '14px' ); ?>;
		--body_font_weight: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_body_font_weight', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_body_font_weight', '' ) : '400' ); ?>;
		--body_text_transform: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_body_text_transform', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_body_text_transform', '' ) : 'none' ); ?>;
		--body_line_height: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_body_line_height', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_body_line_height', '' ) . 'px' : '22px' ); ?>;
		--heading_font_family: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_heading_font', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_heading_font', '' ) : 'Montserrat' ); ?>;
		--h1_font_size: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h1_font_size', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h1_font_size', '' ) . 'px' : '50px' ); ?>;
		--h1_font_weight: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h1_font_weight', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h1_font_weight', '' ) : '700' ); ?>;
		--h1_line_height: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h1_line_height', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h1_line_height', '' ) . 'px' : '50px' ); ?>;
		--h1_text-transform: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h1_text_transform', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h1_text_transform', '' ) : 'none' ); ?>;
		--h2_font_size: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h2_font_size', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h2_font_size', '' ) . 'px' : '32px' ); ?>;
		--h2_font_weight: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h2_font_weight', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h2_font_weight', '' ) : '700' ); ?>;
		--h2_line_height: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h2_line_height', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h2_line_height', '' ) . 'px' : '34px' ); ?>;
		--h2_text-transform: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h2_text_transform', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h2_text_transform', '' ) : 'none' ); ?>;
		--h3_font_size: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h3_font_size', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h3_font_size', '' ) . 'px' : '30px' ); ?>;
		--h3_font_weight: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h3_font_weight', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h3_font_weight', '' ) : '700' ); ?>;
		--h3_line_height: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h3_line_height', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h3_line_height', '' ) . 'px' : '32px' ); ?>;
		--h3_text-transform: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h3_text_transform', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h3_text_transform', '' ) : 'none' ); ?>;
		--h4_font_size: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h4_font_size', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h4_font_size', '' ) . 'px' : '28px' ); ?>;
		--h4_font_weight: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h4_font_weight', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h4_font_weight', '' ) : '700' ); ?>;
		--h4_line_height: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h4_line_height', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h4_line_height', '' ) . 'px' : '30px' ); ?>;
		--h4_text-transform: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h4_text_transform', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h4_text_transform', '' ) : 'none' ); ?>;
		--h5_font_size: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h5_font_size', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h5_font_size', '' ) . 'px' : '24px' ); ?>;
		--h5_font_weight: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h5_font_weight', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h5_font_weight', '' ) : '700' ); ?>;
		--h5_line_height: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h5_line_height', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h5_line_height', '' ) . 'px' : '26px' ); ?>;
		--h5_text-transform: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h5_text_transform', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h5_text_transform', '' ) : 'none' ); ?>;
		--h6_font_size: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h6_font_size', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h6_font_size', '' ) . 'px' : '18px' ); ?>;
		--h6_font_weight: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h6_font_weight', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h6_font_weight', '' ) : '700' ); ?>;
		--h6_line_height: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h6_line_height', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h6_line_height', '' ) . 'px' : '20px' ); ?>;
		--h6_text-transform: <?php echo esc_attr( ( ! empty( get_theme_mod( 'ms_lms_starter_h6_text_transform', '' ) ) ) ? get_theme_mod( 'ms_lms_starter_h6_text_transform', '' ) : 'none' ); ?>;
	}
	<?php
	$css = ob_get_contents();
	ob_end_clean();
	return $css;
}

function starter_theme_activation() {
	if ( empty( get_option( 'stm_theme_settings', '' ) ) ) {
		$theme_options_json = file_get_contents( STM_INCLUDES_PATH . '/config.json', true );
		update_option( 'stm_theme_settings', json_decode( $theme_options_json, true ) );
	}
}

add_action( 'after_switch_theme', 'starter_theme_activation' );

function starter_theme_fonts() {
	$settings = get_option( 'stm_theme_settings', array() );

	$fonts               = array();
	$heading_font_family = get_theme_mod( 'ms_lms_starter_heading_font', '' );

	if ( ! empty( $heading_font_family ) ) {
		$fonts[] = "{$heading_font_family}:{$settings['h1_font']['font-weight']}";
		$fonts[] = "{$heading_font_family}:{$settings['h1_font']['font-weight']}i";
		$fonts[] = "{$heading_font_family}:{$settings['h2_font']['font-weight']}";
		$fonts[] = "{$heading_font_family}:{$settings['h2_font']['font-weight']}i";
		$fonts[] = "{$heading_font_family}:{$settings['h3_font']['font-weight']}";
		$fonts[] = "{$heading_font_family}:{$settings['h3_font']['font-weight']}i";
		$fonts[] = "{$heading_font_family}:{$settings['h4_font']['font-weight']}";
		$fonts[] = "{$heading_font_family}:{$settings['h4_font']['font-weight']}i";
		$fonts[] = "{$heading_font_family}:{$settings['h5_font']['font-weight']}";
		$fonts[] = "{$heading_font_family}:{$settings['h5_font']['font-weight']}i";
		$fonts[] = "{$heading_font_family}:{$settings['h6_font']['font-weight']}";
		$fonts[] = "{$heading_font_family}:{$settings['h6_font']['font-weight']}i";
	} else {
		$fonts[] = 'Montserrat:700,600,500,400';
	}

	$body_font_family = get_theme_mod( 'ms_lms_starter_body_font', '' );

	if ( ! empty( $body_font_family ) ) {
		$fonts[] = "{$body_font_family}:{$settings['body_font']['font-weight']}";
		$fonts[] = "{$body_font_family}:{$settings['body_font']['font-weight']}i";
		$fonts[] = "{$body_font_family}:700";
		$fonts[] = "{$body_font_family}:700i";
	} else {
		$fonts[] = 'Open Sans:700,400';
	}

	$subsets = apply_filters( 'google_fonts_subset', 'latin,latin-ext' );

	$query_args = array(
		'family' => rawurlencode( implode( '|', array_unique( $fonts ) ) ),
		'subset' => rawurlencode( $subsets ),
	);

	$fonts_url = ( ! empty( $fonts ) ) ? add_query_arg( $query_args, 'https://fonts.googleapis.com/css' ) : '';

	return esc_url( $fonts_url );
}

add_action( 'init', 'starter_theme_fonts' );
