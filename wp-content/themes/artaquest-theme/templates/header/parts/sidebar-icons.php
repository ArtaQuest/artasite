<?php
/**
 * iter-151 (arashashra): Kaggle-style left icon sidebar for logged-in users.
 * Reference: kaggle.com Discussions page (image #10). Vertical icon column
 * pinned to the inline-start edge with primary nav links + language pill.
 *
 * Anonymous users do NOT see this sidebar — they get the full horizontal
 * top-bar nav per the iter-150 anonymous layout.
 */

if ( ! is_user_logged_in() ) {
	return;
}

/* Locale-aware URL helper (mirrors footer template). */
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

/* Each item: label, path, inline SVG icon (24×24, stroke 2, currentColor). */
$aq_sidebar_items = array(
	array(
		'label' => __( 'Home', 'artaquest' ),
		'url'   => '/',
		'icon'  => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
	),
	array(
		'label' => __( 'Courses', 'artaquest' ),
		'url'   => '/courses',
		'icon'  => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h6a4 4 0 0 1 4 4v12"/><path d="M22 4h-6a4 4 0 0 0-4 4v12"/></svg>',
	),
	array(
		'label' => __( 'Rankings', 'artaquest' ),
		'url'   => '/rankings',
		'icon'  => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4a2 2 0 0 1-2-2V5h4"/><path d="M18 9h2a2 2 0 0 0 2-2V5h-4"/><path d="M6 22h12"/><path d="M12 17v5"/><path d="M6 4h12v6a6 6 0 1 1-12 0V4z"/></svg>',
	),
	array(
		'label' => __( 'Discussions', 'artaquest' ),
		'url'   => '/discussions',
		'icon'  => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
	),
	array(
		'label' => __( 'Careers', 'artaquest' ),
		'url'   => '/careers',
		'icon'  => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>',
	),
	array(
		'label' => __( 'Donate', 'artaquest' ),
		'url'   => '/donate',
		'icon'  => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
	),
	array(
		'label' => __( 'FAQ & Contact', 'artaquest' ),
		'url'   => '/faq-contact',
		'icon'  => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
	),
);

/* Current path for active-state highlighting. */
$current_path = trim( parse_url( $_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH ) ?: '/', '/' );
?>
<aside id="aq-sidebar" class="aq-sidebar is-expanded" role="navigation" aria-label="<?php esc_attr_e( 'Primary navigation', 'artaquest' ); ?>">
	<?php
	/* iter-224 (Kaggle carbon-copy): primary CTA at top of sidebar, in the
	   same slot Kaggle's "+ Create" button occupies. Gold pill (our colour),
	   Kaggle geometry. */
	$aq_cta = apply_filters( 'aq_sidebar_cta', array(
		'label' => current_user_can( 'edit_posts' ) ? __( 'Create', 'artaquest' ) : __( 'Start Learning', 'artaquest' ),
		'url'   => $aq_localize_url( current_user_can( 'edit_posts' ) ? '/wp-admin/post-new.php?post_type=stm-courses' : '/courses' ),
	) );
	?>
	<a class="aq-sidebar__cta" href="<?php echo esc_url( $aq_cta['url'] ); ?>" aria-label="<?php echo esc_attr( $aq_cta['label'] ); ?>">
		<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
		<span><?php echo esc_html( $aq_cta['label'] ); ?></span>
	</a>
	<ul class="aq-sidebar__list">
		<?php foreach ( $aq_sidebar_items as $item ) :
			$item_path   = trim( $item['url'], '/' );
			$is_active   = ( '' === $current_path && '' === $item_path ) || ( '' !== $item_path && 0 === strpos( $current_path, $item_path ) );
			$active_attr = $is_active ? ' aria-current="page"' : '';
			$active_cls  = $is_active ? ' aq-sidebar__item--active' : '';
			?>
			<li class="aq-sidebar__item<?php echo esc_attr( $active_cls ); ?>">
				<a href="<?php echo esc_url( $aq_localize_url( $item['url'] ) ); ?>"<?php echo $active_attr; ?> class="aq-sidebar__link" title="<?php echo esc_attr( $item['label'] ); ?>">
					<?php echo $item['icon']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped — static SVG ?>
					<span class="aq-sidebar__label"><?php echo esc_html( $item['label'] ); ?></span>
				</a>
			</li>
		<?php endforeach; ?>
	</ul>

	<?php
	/* iter-224 (Kaggle carbon-copy): "Your Work" section with the user's
	   enrolled courses. Mirrors Kaggle's "Your Work › Viewed › <recent items>"
	   group at the bottom of the sidebar. */
	$aq_user_id = get_current_user_id();
	$aq_enrolled = array();
	if ( $aq_user_id ) {
		/* No public helper; do a direct, small SELECT. */
		global $wpdb;
		/* The fork renamed wp_stm_lms_* → wp_artaquest_* — check both. */
		$tbl = $wpdb->prefix . 'artaquest_user_courses';
		if ( $wpdb->get_var( "SHOW TABLES LIKE '{$tbl}'" ) !== $tbl ) {
			$tbl = $wpdb->prefix . 'stm_lms_user_courses';
		}
		if ( $wpdb->get_var( "SHOW TABLES LIKE '{$tbl}'" ) === $tbl ) {
			$rows = $wpdb->get_results( $wpdb->prepare(
				"SELECT course_id, progress_percent FROM {$tbl} WHERE user_id=%d ORDER BY start_time DESC LIMIT 5",
				$aq_user_id
			) );
			foreach ( (array) $rows as $r ) {
				/* iter-224 FIX: must NOT use $post here — load_template()
				   globalizes $post into this template's scope, so assigning
				   to it clobbers the main query's current post. index.php
				   then calls get_post_type() (which reads the global $post)
				   to pick the content template, and would load
				   templates/stm-courses/index (nonexistent) → empty <main>.
				   Use a local var name instead. */
				$aq_course_post = get_post( (int) $r->course_id );
				if ( ! $aq_course_post || 'publish' !== $aq_course_post->post_status ) { continue; }
				$aq_enrolled[] = array(
					'id'       => $aq_course_post->ID,
					'title'    => $aq_course_post->post_title,
					'url'      => $aq_localize_url( '/courses/' . $aq_course_post->post_name . '/' ),
					'thumb'    => get_the_post_thumbnail_url( $aq_course_post->ID, 'thumbnail' ),
					'progress' => (int) ( $r->progress_percent ?? 0 ),
				);
			}
			unset( $aq_course_post );
		}
	}
	if ( ! empty( $aq_enrolled ) ) :
		?>
		<div class="aq-sidebar__section">
			<div class="aq-sidebar__section-title"><?php esc_html_e( 'Your work', 'artaquest' ); ?></div>
			<ul class="aq-sidebar__recents">
				<?php foreach ( $aq_enrolled as $course ) : ?>
					<li class="aq-sidebar__recent">
						<a href="<?php echo esc_url( $course['url'] ); ?>" title="<?php echo esc_attr( $course['title'] ); ?>">
							<?php if ( $course['thumb'] ) : ?>
								<img src="<?php echo esc_url( $course['thumb'] ); ?>" alt="" loading="lazy" width="28" height="28">
							<?php else : ?>
								<span class="aq-sidebar__recent-placeholder" aria-hidden="true">📘</span>
							<?php endif; ?>
							<span class="aq-sidebar__recent-title"><?php echo esc_html( $course['title'] ); ?></span>
						</a>
					</li>
				<?php endforeach; ?>
			</ul>
		</div>
	<?php endif; ?>

	<div class="aq-sidebar__spacer"></div>
	<div class="aq-sidebar__lang">
		<?php get_template_part( 'templates/header/parts/language-selector' ); ?>
	</div>
</aside>
