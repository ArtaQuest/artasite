<?php
/**
 * 404 — Page-not-found template.
 *
 * Brand-aligned dark layout. Uses the same yang/yin two-color motif as
 * the hero section. Provides two CTAs: "Back to home" (yang fill) and
 * "Browse courses" (yin ghost).
 */
get_header();
?>
<div id="wrapper" class="wrapper">
	<section class="ay-404">
		<div class="ay-404__inner">
			<div class="ay-404__code" aria-hidden="true">404</div>
			<h1 class="ay-404__title">
				<?php esc_html_e( 'This page is off the map', 'artaquest-theme' ); ?>
			</h1>
			<p class="ay-404__lede">
				<?php esc_html_e( 'The page you tried to reach is not here. It may have moved, been renamed, or never existed. Use the menu, or head back to the home page.', 'artaquest-theme' ); ?>
			</p>
			<div class="ay-404__actions">
				<a href="<?php echo esc_url( home_url( '/' ) ); ?>" class="ay-404__btn ay-404__btn--primary">
					<?php esc_html_e( 'Back to home', 'artaquest-theme' ); ?>
				</a>
				<a href="<?php echo esc_url( home_url( '/courses/' ) ); ?>" class="ay-404__btn ay-404__btn--ghost">
					<?php esc_html_e( 'Browse courses', 'artaquest-theme' ); ?>
				</a>
			</div>
		</div>
	</section>
</div>
<?php get_footer();
