<?php

$tags = wp_get_post_terms( get_the_id(), 'post_tag', array( 'fields' => 'ids' ) );

$args = array(
	'post__not_in'        => array( get_the_id() ),
	'posts_per_page'      => 3,
	'ignore_sticky_posts' => 1,
	'orderby'             => 'rand',
	'tax_query'           => array(
		array(
			'taxonomy' => 'post_tag',
			'terms'    => $tags,
		),
	),
);

$q = new wp_query( $args );

if ( $q->have_posts() ) : ?>
	<div class="related-posts">
		<div class="container">
			<h3><?php esc_html_e( 'Related Posts', 'starter-text-domain' ); ?></h3>

			<div class="starter-row">
				<?php
				while (
					$q->have_posts() ) :
					$q->the_post();
					?>
					<div class="stm-col-lg-4 stm-col-md-4 stm-col-sm-12">
						<div class="content-info posted_default">
							<?php if ( has_post_thumbnail() ) : ?>
								<div class="content-info-thumbnail">
									<a href="<?php echo esc_url( get_permalink() ); ?>"><?php the_post_thumbnail( 'large' ); ?></a>
								</div>
								<?php
							endif;

							$categories = get_the_category();
							if ( ! empty( $categories ) ) :
								?>
								<div class="content-info-category-list">
									<?php
									foreach ( $categories as $category ) :
										printf(
											'<a href="%1$s" title="%2$s">%3$s</a>',
											esc_url( get_category_link( $category->term_id ) ),
											esc_attr( $category->name ),
											esc_html( $category->name )
										);
									endforeach;
									?>
								</div>
							<?php endif; ?>

							<div class="content-info-title"><a href="<?php echo esc_url( get_permalink() ); ?>"><?php the_title(); ?></a></div>

							<?php if ( get_the_excerpt() ) : ?>
								<div class="content-info-description">
									<?php echo wp_kses_post( starter_minimize_word( get_the_excerpt(), 150 ) ); ?>
								</div>
							<?php endif; ?>

							<div class="content-info-date">
								<?php echo esc_html( get_the_date( get_option( 'date_format' ) ) ); ?>
							</div>
						</div>
					</div>
				<?php endwhile; ?>
			</div>
		</div>
	</div>

	<?php
	wp_reset_postdata();
endif;
