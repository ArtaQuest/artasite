<?php
	$settings = get_option( 'stm_theme_settings', array() );
if ( have_posts() ) {
	while ( have_posts() ) :
		the_post();

		echo '<main class="post-container">';
			get_template_part( 'templates/single/post/parts/date' );
			get_template_part( 'templates/single/post/parts/title' );
			get_template_part( 'templates/single/post/parts/excerpt' );
			get_template_part( 'templates/single/post/parts/taxonomy' );
		echo '</main>';

		get_template_part( 'templates/single/post/parts/thumbnail' );

		echo '<main class="post-container">';
			get_template_part( 'templates/single/post/parts/share' );
			get_template_part( 'templates/single/post/parts/content' );
			get_template_part( 'templates/single/post/parts/next-page' );
			get_template_part( 'templates/single/post/parts/tags' );
			get_template_part( 'templates/single/post/parts/author' );
			get_template_part( 'templates/single/post/parts/comments' );
		echo '</main>';

		get_template_part( 'templates/single/post/parts/related-posts' );
	endwhile;
} else {
	get_template_part( 'templates/content', 'none' );
}
