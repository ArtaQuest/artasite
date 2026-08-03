<?php
$post_tags = get_the_tags();

if ( $post_tags ) : ?>
	<div class="post-tags-list">
		<?php foreach ( $post_tags as $post_tag ) : ?>
			<a href="<?php echo esc_url( get_tag_link( $post_tag ) ); ?>" title="<?php echo esc_attr( $post_tag->name ); ?>">
				<?php echo esc_attr( $post_tag->name ); ?>
			</a>
		<?php endforeach; ?>
	</div>
<?php endif; ?>
