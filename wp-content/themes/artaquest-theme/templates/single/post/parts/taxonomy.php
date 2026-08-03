<?php
if ( get_the_category() ) : ?>
	<div class="post-categories">
		<?php echo wp_kses_post( get_the_category_list() ); ?>
	</div>
	<?php
endif;
