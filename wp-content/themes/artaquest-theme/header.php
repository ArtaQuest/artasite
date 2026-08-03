<!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<?php
	// SEO meta (og:* / twitter:* / canonical / hreflang / JSON-LD) is
	// emitted by AQ_I18N_SEO during wp_head — no duplicates here.
	// og:type is set there per-context (article for single posts/
	// courses, website for everything else).
	?>
	<link rel="profile" href="https://gmpg.org/xfn/11">
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<a class="skip-link screen-reader-text" href="#main"><?php esc_html_e( 'Skip to content', 'artaquest' ); ?></a>
<?php
	get_template_part( 'templates/header/index' );
