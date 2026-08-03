<?php
$skin = get_option( 'theme_mods_ms-lms-starter-theme' );

if ( have_posts() ) : ?>
	<div class="posts-template post-layout-<?php echo esc_attr( $skin['ms_lms_starter_blog_skin'] ); ?> post-layout-columns-<?php echo esc_attr( $skin['ms_lms_starter_blog_skin_columns'] ); ?>">
		<?php
		$blog_page_id = get_option( 'page_for_posts' );

		if ( $blog_page_id ) {
			$blog_page_title = get_the_title( $blog_page_id );
			echo '<h2>' . esc_html( $blog_page_title ) . '</h2>';
		}

		while ( have_posts() ) {
			the_post();
			?>
			<section id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
				<?php get_template_part( 'templates/post/parts/featured-image' ); ?>
				<div class="post-main">
					<?php if ( is_sticky() ) : ?>
						<div class="post-sticky-badge"><?php esc_html_e( 'Sticky post', 'starter-text-domain' ); ?></div>
						<?php
					endif;
					get_template_part( 'templates/post/parts/category' );
					get_template_part( 'templates/post/parts/title' );
					get_template_part( 'templates/post/parts/excerpt' );
					get_template_part( 'templates/post/parts/date' );
					?>
				</div>
			</section>
			<?php
		}
			posts_pages_pagination( 'posts_pages_pagination' );
			wp_reset_postdata();
		?>
	</div>
<?php endif; ?>
