<?php
/* iter-152 (arashashra): Kaggle-EXACT layout pass #2 (refining iter-150/151).
   Reference: kaggle.com image #12.

   ANONYMOUS LTR:    [logo] [nav inline]              [wide search] [Sign In] [Lang ▾]
   LOGGED-IN LTR:    [☰ toggle] [logo]                [wide search]              [Avatar]
                     + LEFT SIDEBAR (collapsed 60px ↔ expanded 240px on ham click).

   Lang switcher is ALWAYS the right-most element for anonymous.
   For logged-in, the lang switcher is at the BOTTOM of the sidebar.
   Search bar takes ALL the available horizontal space, not a compact pill. */

$aq_search_url = home_url( '/?s=' );
if ( class_exists( 'AQ_I18N_Router' )
	&& method_exists( 'AQ_I18N_Router', 'convert_url' )
	&& method_exists( 'AQ_I18N_Router', 'current' ) ) {
	$lang_now = AQ_I18N_Router::current();
	if ( $lang_now ) {
		$maybe = AQ_I18N_Router::convert_url( $aq_search_url, $lang_now );
		if ( is_string( $maybe ) && '' !== $maybe ) {
			$aq_search_url = $maybe;
		}
	}
}

$aq_user_logged_in = is_user_logged_in();
?>
<header class="header<?php echo $aq_user_logged_in ? ' header--auth' : ''; ?>" id="header">
	<div class="container">
		<section class="navigation">
			<?php
			/* Sidebar-toggle hamburger — LOGGED-IN ONLY. Opens/collapses
			   the .aq-sidebar from 60px (icons only) to 240px (icons+labels). */
			if ( $aq_user_logged_in ) :
				?>
				<button type="button"
					class="aq-sidebar-toggle"
					aria-label="<?php esc_attr_e( 'Toggle navigation', 'artaquest' ); ?>"
					aria-controls="aq-sidebar"
					aria-expanded="false">
					<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<line x1="3"  y1="6"  x2="21" y2="6"/>
						<line x1="3"  y1="12" x2="21" y2="12"/>
						<line x1="3"  y1="18" x2="21" y2="18"/>
					</svg>
				</button>
				<?php
			endif;

			get_template_part( 'templates/header/parts/logo' );

			/* iter-182 #555 (jisoo Z Fold6 folded 344pt): the previous
			   "skip the menu render entirely for logged-in users" left
			   logged-in phone users with NO navigation at all — the
			   sidebar is hidden below 640pt and the mobile-switcher
			   hamburger lives inside the menu template. Result was a
			   dead-end header (logo + avatar circle, nothing else).
			   Always render the menu template; the mobile-switcher
			   inside it is gated by CSS so it only shows when the
			   sidebar can't (≤639) for logged-in users, and the inline
			   nav UL is hidden for sidebar users at all widths by
			   `body:has(.aq-sidebar) .header .navigation .navigation-menu
			   .starter-menu { display: none }` (~line 17021). */
			get_template_part( 'templates/header/parts/menu' );
			?>

			<!-- Wide search bar — takes ALL available horizontal space (Kaggle pattern). -->
			<a class="aq-search-bar" href="<?php echo esc_url( $aq_search_url ); ?>" aria-label="<?php esc_attr_e( 'Search', 'artaquest' ); ?>">
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="11" cy="11" r="7"/>
					<path d="M21 21l-4.35-4.35"/>
				</svg>
				<span class="aq-search-bar__placeholder"><?php esc_html_e( 'Search', 'artaquest' ); ?></span>
			</a>

			<?php
			// Cart indicator: only renders when the cart is non-empty.
			get_template_part( 'templates/header/parts/cart-indicator' );

			// Authorization (Sign In + Register for anon, avatar circle for logged-in).
			if ( defined( 'MS_LMS_VERSION' ) ) {
				get_template_part( 'templates/header/parts/authorization-links' );
			}
			/* Language is no longer a separate trailing element: it is
			   injected as the LAST item of the primary nav (Kaggle pattern,
			   user directive 2026-05-24) via the
			   `ay_i18n_auto_inject_switcher` filter — see functions.php.
			   Logged-in users still get it in the sidebar / drawer. */
			?>
		</section>
	</div>
</header>
<?php
// Logged-in vertical icon sidebar — renders AFTER the header.
get_template_part( 'templates/header/parts/sidebar-icons' );
?>

<?php if ( $aq_user_logged_in ) : ?>
<script>
/* iter-152: hamburger toggle for the sidebar. Adds .is-expanded to
   <aside class="aq-sidebar"> and updates aria-expanded on the button.
   Persists state in localStorage so it stays across navigation. */
(function () {
	var btn = document.querySelector('.aq-sidebar-toggle');
	var bar = document.getElementById('aq-sidebar');
	if (!btn || !bar) return;
	var KEY = 'aq.sidebar.expanded';
	function apply(open) {
		bar.classList.toggle('is-expanded', open);
		document.documentElement.classList.toggle('aq-sb-expanded', open);
		btn.setAttribute('aria-expanded', open ? 'true' : 'false');
		try { localStorage.setItem(KEY, open ? '1' : '0'); } catch (e) {}
	}
	try {
			/* iter-224 (Kaggle carbon-copy): default to EXPANDED. */
			var stored = localStorage.getItem(KEY);
			apply(stored !== "0");
		} catch (e) { apply(true); }
	btn.addEventListener('click', function () {
		apply(!bar.classList.contains('is-expanded'));
	});
})();
</script>
<?php endif; ?>
