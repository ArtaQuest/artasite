<!doctype html>
<?php
// language_attributes() reports WP's own locale — 'en-US' — and never a dir, because the i18n router
// is ArtaQuest's, not WordPress's. The SPA template sets both correctly, but THIS header serves
// search.php / single.php / archive.php, and /fa/?s=<query> is the very URL the site's own
// SearchAction advertises in its JSON-LD (aq-seo-schema.php). So a Persian search-results page
// arrived as lang="en-US" with no direction at all: unmirrored layout, and a screen reader
// announcing Persian text in an English voice. Mirror I18n::RTL rather than repeating the list.
$aq_hdr_lang = class_exists( '\AQ\I18n' ) ? \AQ\I18n::current() : '';
$aq_hdr_dir  = ( $aq_hdr_lang && in_array( $aq_hdr_lang, \AQ\I18n::RTL, true ) ) ? 'rtl' : 'ltr';
?>
<html <?php echo $aq_hdr_lang ? 'lang="' . esc_attr( $aq_hdr_lang ) . '" dir="' . esc_attr( $aq_hdr_dir ) . '"' : get_language_attributes(); ?>>
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
