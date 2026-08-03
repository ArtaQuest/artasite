<?php
/**
 * Header cart indicator.
 *
 * Shows a small cart icon + item count, linking to /checkout/, but ONLY when
 * the cart is non-empty. Priya realbot 2026-05-21: a donor who added a
 * donation had no way to reach the cart/checkout from the navigation, so the
 * donation could never be completed.
 *
 * Inline SVG only (FontAwesome is not loaded on the front end). Scoped to the
 * brand palette via CSS in style.css.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
if ( ! function_exists( 'WC' ) || ! WC() || ! WC()->cart ) {
	return;
}
$count = (int) WC()->cart->get_cart_contents_count();
if ( $count < 1 ) {
	return;
}
$checkout_url = function_exists( 'wc_get_checkout_url' ) ? wc_get_checkout_url() : home_url( '/checkout/' );
/* translators: %d: number of items in the cart */
$label = sprintf( _n( 'Checkout — %d item', 'Checkout — %d items', $count, 'artaquest' ), $count );
?>
<a class="header__cart" href="<?php echo esc_url( $checkout_url ); ?>" aria-label="<?php echo esc_attr( $label ); ?>">
	<svg class="header__cart-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
		<path d="M2 3h2.2l1.2 2m0 0 1.9 9.2a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.1L21.5 7H5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
		<circle cx="9.5" cy="20" r="1.4" fill="currentColor"/>
		<circle cx="17.5" cy="20" r="1.4" fill="currentColor"/>
	</svg>
	<span class="header__cart-count" aria-hidden="true"><?php echo esc_html( number_format_i18n( $count ) ); ?></span>
</a>
