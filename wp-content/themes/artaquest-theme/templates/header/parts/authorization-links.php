<?php
wp_enqueue_style( 'profile-auth-links-style' );

$login_icon_width         = get_theme_mod( 'ms_lms_starter_login_icon_width' ) ? get_theme_mod( 'ms_lms_starter_login_icon_width' ) : '50';
$login_icon_height        = get_theme_mod( 'ms_lms_starter_login_icon_height' ) ? get_theme_mod( 'ms_lms_starter_login_icon_height' ) : '50';
$login_icon_size          = get_theme_mod( 'ms_lms_starter_login_icon_size' ) ? get_theme_mod( 'ms_lms_starter_login_icon_size' ) : '14';
$login_icon_color         = get_theme_mod( 'ms_lms_starter_login_icon_color' ) ? get_theme_mod( 'ms_lms_starter_login_icon_color' ) : '#ffffff';
$login_icon_bg_color      = get_theme_mod( 'ms_lms_starter_login_icon_bg_color' ) ? get_theme_mod( 'ms_lms_starter_login_icon_bg_color' ) : '#227AFF';
$login_link_text          = get_theme_mod( 'ms_lms_starter_login_link_text' ) ? get_theme_mod( 'ms_lms_starter_login_link_text' ) : esc_html__( 'login/sign up', 'starter-text-domain' );
$login_link_size          = get_theme_mod( 'ms_lms_starter_login_link_size' ) ? get_theme_mod( 'ms_lms_starter_login_link_size' ) : '12';
$login_link_color         = get_theme_mod( 'ms_lms_starter_login_link_color' ) ? get_theme_mod( 'ms_lms_starter_login_link_color' ) : '#2A3045';
$login_link_hover_color   = get_theme_mod( 'ms_lms_starter_login_link_hover_color' ) ? get_theme_mod( 'ms_lms_starter_login_link_hover_color' ) : '#2A3045';
$sing_in_icon_size        = get_theme_mod( 'ms_lms_starter_login_sing_in_icon_size' ) ? get_theme_mod( 'ms_lms_starter_login_sing_in_icon_size' ) : '14';
$sing_in_icon_color       = get_theme_mod( 'ms_lms_starter_login_sing_in_icon_color' ) ? get_theme_mod( 'ms_lms_starter_login_sing_in_icon_color' ) : '#385bce';
$sing_in_text_size        = get_theme_mod( 'ms_lms_starter_login_sing_in_text_size' ) ? get_theme_mod( 'ms_lms_starter_login_sing_in_text_size' ) : '14';
$sing_in_text_color       = get_theme_mod( 'ms_lms_starter_login_sing_in_text_color' ) ? get_theme_mod( 'ms_lms_starter_login_sing_in_text_color' ) : '#333333';
$sing_in_text_hover_color = get_theme_mod( 'ms_lms_starter_login_sing_in_text_hover_color' ) ? get_theme_mod( 'ms_lms_starter_login_sing_in_text_hover_color' ) : '#385bce';
$sing_in_bg_color         = get_theme_mod( 'ms_lms_starter_login_sing_in_bg_color' ) ? get_theme_mod( 'ms_lms_starter_login_sing_in_bg_color' ) : '#f0f4fa';
$sing_in_bg_hover_color   = get_theme_mod( 'ms_lms_starter_login_sing_in_bg_hover_color' ) ? get_theme_mod( 'ms_lms_starter_login_sing_in_bg_hover_color' ) : '#f0f4fa';
?>
<style>
:root {
	--stm-lms-auth-links-login-icon-width: <?php echo esc_attr( $login_icon_width ); ?>px;
	--stm-lms-auth-links-login-icon-height: <?php echo esc_attr( $login_icon_height ); ?>px;
	--stm-lms-auth-links-login-icon-size: <?php echo esc_attr( $login_icon_size ); ?>px;
	--stm-lms-auth-links-login-icon-color: <?php echo esc_attr( $login_icon_color ); ?>;
	--stm-lms-auth-links-login-icon-bg-color: <?php echo esc_attr( $login_icon_bg_color ); ?>;
	--stm-lms-auth-links-login-link-size: <?php echo esc_attr( $login_link_size ); ?>px;
	--stm-lms-auth-links-login-link-color: <?php echo esc_attr( $login_link_color ); ?>;
	--stm-lms-auth-links-login-link-hover-color: <?php echo esc_attr( $login_link_hover_color ); ?>;
	--stm-lms-auth-links-sing-in-icon-size: <?php echo esc_attr( $sing_in_icon_size ); ?>px;
	--stm-lms-auth-links-sing-in-icon-color: <?php echo esc_attr( $sing_in_icon_color ); ?>;
	--stm-lms-auth-links-sing-in-text-size: <?php echo esc_attr( $sing_in_text_size ); ?>px;
	--stm-lms-auth-links-sing-in-text-color: <?php echo esc_attr( $sing_in_text_color ); ?>;
	--stm-lms-auth-links-sing-in-text-hover-color: <?php echo esc_attr( $sing_in_text_hover_color ); ?>;
	--stm-lms-auth-links-sing-in-bg-color: <?php echo esc_attr( $sing_in_bg_color ); ?>;
	--stm-lms-auth-links-sing-in-bg-hover-color: <?php echo esc_attr( $sing_in_bg_hover_color ); ?>;
}
</style>
<?php

if ( ! is_user_logged_in() ) {
	/* iter-223 (user directive 2026-05-24): Kaggle-exact trailing cluster —
	   a plain "Sign In" text link followed by a solid "Register" pill. The
	   pill is the primary CTA; the text link is the secondary path. Both
	   point at the LMS auth page (which carries a built-in Sign-In ⇄ Sign-Up
	   toggle); `aq_register_url` lets a future dedicated register page win. */
	$login_url = '';
	if ( class_exists( 'STM_LMS_User' ) ) {
		$login_url = \STM_LMS_User::login_page_url();
	}
	$register_url = apply_filters( 'aq_register_url', $login_url );
	?>
	<div class="aq-authgroup">
		<a href="<?php echo esc_url( $login_url ); ?>" class="aq-signin-link" aria-label="<?php echo esc_attr__( 'Sign in', 'artaquest' ); ?>">
			<?php echo esc_html__( 'Sign In', 'artaquest' ); ?>
		</a>
		<a href="<?php echo esc_url( $register_url ); ?>" class="aq-register-btn" aria-label="<?php echo esc_attr__( 'Register', 'artaquest' ); ?>">
			<?php echo esc_html__( 'Register', 'artaquest' ); ?>
		</a>
	</div>
	<?php
} else {
	\STM_LMS_Templates::show_lms_template( 'global/account-dropdown' );
}
