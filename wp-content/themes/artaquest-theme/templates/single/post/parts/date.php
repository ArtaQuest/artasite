<?php
$posted = get_the_time( 'U' );
if ( $posted ) : ?>
	<div class="post-date">
		<?php echo esc_html( get_the_date( get_option( 'date_format' ) ) ); ?>
	</div>
	<?php
endif;
