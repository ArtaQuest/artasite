<?php
/* iter-132 (arashashra): Kaggle-style footer — 4 columns.
   Left BRAND column carries the wordmark + social icons. Three link
   columns ("Learn", "Programme", "Legal") map our existing pages onto
   the kaggle.com Product/Resources/Company rhythm. ArtaQuest stays
   dark-theme; everything else is the Kaggle layout. */

$copyright_text = get_theme_mod( 'ms_lms_starter_copyright_text' );

/* Social links — Instagram, X, YouTube, LinkedIn. URLs overridable via
   aq_social_* options; the brand-handle defaults render immediately. */
$aq_svg = array(
	'instagram' => '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.66 4.77-4.92 4.92-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85C2.38 3.92 3.9 2.38 7.15 2.23 8.42 2.17 8.8 2.16 12 2.16zM12 0C8.74 0 8.33.01 7.05.07 2.7.27.27 2.69.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.2 4.36 2.62 6.78 6.98 6.98C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c4.35-.2 6.78-2.62 6.98-6.98.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95C23.73 2.7 21.31.27 16.95.07 15.67.01 15.26 0 12 0zm0 5.84a6.16 6.16 0 100 12.32 6.16 6.16 0 000-12.32zM12 16a4 4 0 110-8 4 4 0 010 8zm6.4-10.85a1.44 1.44 0 100 2.88 1.44 1.44 0 000-2.88z"/></svg>',
	'x'         => '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.48l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93zm-1.29 19.5h2.04L6.48 3.24H4.29L17.61 20.65z"/></svg>',
	'youtube'   => '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M23.5 6.19a3.02 3.02 0 00-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 00.5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 002.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 002.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.6 15.6V8.4l6.2 3.6-6.2 3.6z"/></svg>',
	'linkedin'  => '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.66H9.35V9h3.42v1.56h.05c.47-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 110-4.13 2.07 2.07 0 010 4.13zm1.78 13.02H3.55V9h3.57v11.45zM22.22 0H1.77C.8 0 0 .78 0 1.74v20.52C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.74V1.74C24 .78 23.2 0 22.22 0z"/></svg>',
	'tiktok'    => '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
	'facebook'  => '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"/></svg>',
	'pinterest' => '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z"/></svg>',
	'github'    => '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z"/></svg>',
);
/* URLs come from aq_social_profiles() (aq-seo-schema.php) — the ONE PHP copy of the roster, shared
   with the Organization node's `sameAs`. This template used to keep its own get_option() defaults,
   and because the aq_social_* options are unset in production the two literals drifted: this footer
   went on serving the dead `x.com/artaquestorg` on the /?s= search route long after the handle
   moved. Labels + glyphs stay here (presentation); the roster does not. */
$aq_labels = array(
	'instagram' => 'Instagram',
	'x'         => 'X',
	'youtube'   => 'YouTube',
	'tiktok'    => 'TikTok',
	'facebook'  => 'Facebook',
	'pinterest' => 'Pinterest',
	'linkedin'  => 'LinkedIn',
	'github'    => 'GitHub',
);
$socials = array();
foreach ( function_exists( 'aq_social_profiles' ) ? aq_social_profiles() : array() as $aq_k => $aq_url ) {
	$socials[ $aq_k ] = array( 'url' => $aq_url, 'label' => isset( $aq_labels[ $aq_k ] ) ? $aq_labels[ $aq_k ] : ucfirst( $aq_k ) );
}

/* Three Kaggle-style link columns. Kaggle uses Product / Resources /
   Company. Mapped onto ArtaQuest pages. */
$footer_columns = array(
	array(
		'heading' => __( 'Learn', 'artaquest' ),
		'links'   => array(
			array( 'label' => __( 'Courses',      'artaquest' ), 'url' => '/courses' ),
			array( 'label' => __( 'Pricing',      'artaquest' ), 'url' => '/pricing' ),
			array( 'label' => __( 'Bursaries',    'artaquest' ), 'url' => '/bursaries' ),
			array( 'label' => __( 'Rankings', 'artaquest' ), 'url' => '/rankings' ),
			array( 'label' => __( 'FAQ & Contact','artaquest' ), 'url' => '/faq-contact' ),
		),
	),
	array(
		'heading' => __( 'Programme', 'artaquest' ),
		'links'   => array(
			array( 'label' => __( 'About',   'artaquest' ), 'url' => '/about' ),
			array( 'label' => __( 'Careers', 'artaquest' ), 'url' => '/careers' ),
			array( 'label' => __( 'Donate',  'artaquest' ), 'url' => '/donate' ),
		),
	),
	array(
		'heading' => __( 'Legal', 'artaquest' ),
		'links'   => array(
			array( 'label' => __( 'Code of Conduct',    'artaquest' ), 'url' => '/code-of-conduct' ),
			array( 'label' => __( 'Privacy Policy',     'artaquest' ), 'url' => '/privacy-policy' ),
			array( 'label' => __( 'Terms & Conditions', 'artaquest' ), 'url' => '/terms-and-conditions' ),
		),
	),
);

/* Locale-aware URL conversion — bare paths drop the visitor out of their
   language (Layla CRITICAL 2026-05-20). Route through home_url() +
   AQ_I18N_Router::convert_url(). */
$aq_localize_url = static function ( $path ) {
	$url = home_url( $path );
	if ( class_exists( 'AQ_I18N_Router' )
		&& method_exists( 'AQ_I18N_Router', 'convert_url' )
		&& method_exists( 'AQ_I18N_Router', 'current' ) ) {
		$lang_now = AQ_I18N_Router::current();
		if ( $lang_now ) {
			$maybe = AQ_I18N_Router::convert_url( $url, $lang_now );
			if ( is_string( $maybe ) && '' !== $maybe ) {
				$url = $maybe;
			}
		}
	}
	return $url;
};
?>
<footer class="footer ay-footer" role="contentinfo">
	<div class="container ay-footer__inner">

		<!-- BRAND column — logo + social icons.
		     iter-134 #468 (ren): the logo template emits its OWN <a>, so
		     wrapping it in another <a> here produced nested anchors —
		     browsers auto-close one and mangle the DOM, which collapsed
		     the entire 4-column footer layout. Render the logo template
		     bare; its inner anchor is the brand link. -->
		<div class="ay-footer__brand">
			<div class="ay-footer__logo">
				<?php get_template_part( 'templates/header/parts/logo' ); ?>
			</div>
			<ul class="ay-footer__social" aria-label="Social media links">
				<?php foreach ( $socials as $key => $data ) : if ( empty( $data['url'] ) ) { continue; } ?>
				<li>
					<a href="<?php echo esc_url( $data['url'] ); ?>"
						aria-label="<?php echo esc_attr( $data['label'] ); ?>"
						rel="noopener noreferrer" target="_blank">
						<?php
						echo isset( $aq_svg[ $key ] ) ? $aq_svg[ $key ] : ''; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
						?>
					</a>
				</li>
				<?php endforeach; ?>
			</ul>
		</div>

		<!-- LINK columns -->
		<?php foreach ( $footer_columns as $col ) : ?>
			<nav class="ay-footer__col" aria-label="<?php echo esc_attr( $col['heading'] ); ?>">
				<h3 class="ay-footer__col-heading"><?php echo esc_html( $col['heading'] ); ?></h3>
				<ul class="ay-footer__col-list">
					<?php foreach ( $col['links'] as $link ) : ?>
						<li><a href="<?php echo esc_url( $aq_localize_url( $link['url'] ) ); ?>"><?php echo esc_html( $link['label'] ); ?></a></li>
					<?php endforeach; ?>
				</ul>
			</nav>
		<?php endforeach; ?>

	</div>

	<!-- Bottom bar — copyright + legal entity. Kaggle puts this in a thin
	     row below the columns. -->
	<div class="ay-footer__bottom">
		<div class="container">
			<span class="ay-footer__copy">
				<?php
				$entity = get_option( 'aq_legal_entity', array() );
				if ( empty( $copyright_text ) ) {
					$legal_name = isset( $entity['name'] ) ? $entity['name'] : 'ArtaQuest Foundation';
					echo wp_kses_post( '&copy; ' . date( 'Y' ) . ' ' . esc_html( $legal_name ) );
				} else {
					echo wp_kses_post( $copyright_text );
				}
				?>
			</span>
		</div>
	</div>
</footer>
