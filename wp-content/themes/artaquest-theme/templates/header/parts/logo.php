<?php
/**
 * ArtaQuest logo — "Quest" brand mark.
 *
 * iter-283 (user directive 2026-05-24): apply the supplied brand artwork —
 * a magnifying-glass "Q" enclosing the yin-yang (gold Yang + blue Yin),
 * followed by the "uest" wordmark in brand blue. This is a graphic logo,
 * so it is language-agnostic: the same mark renders across all 8 locales
 * (no per-language transliteration of a wordmark image).
 *
 * Source art converted from CUCtu.jpg → trimmed transparent PNG
 * (824×294) at assets/images/quest-logo.png + a 2x retina asset.
 * Geometry copies Kaggle (mark anchored top-left, ~28px tall); brand
 * colours stay ours (Yin #2352E8 + Yang #E8B923).
 */
$ay_lang = class_exists( 'AQ_I18N_Router' ) ? AQ_I18N_Router::current() : 'en';
$ay_rtl  = in_array( $ay_lang, array( 'ar', 'fa', 'ur' ), true );

// iter-348 (user 2026-05-25): replace text wordmark with the AQ brand mark —
// gold "AQ" on a blue rounded tile (see aq_brand_svg() in functions.php).
?>
<a href="<?php echo esc_url( home_url( '/' ) ); ?>"
   class="starter-logo ay-logo ay-logo--<?php echo $ay_rtl ? 'rtl' : 'ltr'; ?> ay-logo--mark"
   aria-label="<?php echo esc_attr( get_bloginfo( 'name' ) . ' — Home' ); ?>">
	<?php echo function_exists( 'aq_brand_svg' ) ? aq_brand_svg( 32 ) : ''; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
</a>
