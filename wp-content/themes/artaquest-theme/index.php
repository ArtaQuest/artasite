<?php get_header(); ?>
<div id="wrapper" class="wrapper">
	<main id="main" class="container">
		<?php get_template_part( 'templates/' . get_post_type() . '/index' ); ?>
	</main>
</div>
<?php
get_footer();
