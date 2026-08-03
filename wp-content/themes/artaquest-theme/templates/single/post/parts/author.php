<?php
$author_first_name = get_the_author_meta( 'first_name' );
$author_last_name  = get_the_author_meta( 'last_name' );
$author_login      = get_the_author_meta( 'display_name' );
$author_bio        = get_the_author_meta( 'description' );
?>
<div class="single-post-author-bio">
	<div class="single-post-author-bio__avatar">
		<?php
		$author_id     = get_the_author_meta( 'ID' );
		$custom_avatar = get_user_meta( $author_id, 'stm_lms_user_avatar', true );

		if ( ! empty( $custom_avatar ) ) {
			echo '<img src="' . esc_url( $custom_avatar ) . '" alt="' . esc_attr( get_the_author_meta( 'display_name', $author_id ) ) . '" width="78" height="78">';
		} else {
			echo get_avatar( get_the_author_meta( 'email' ), 78 );
		}
		?>
	</div>
	<div class="single-post-author-bio__info">
		<div class="single-post-author-bio__name">
			<?php
			if ( ! empty( $author_first_name ) || ! empty( $author_last_name ) ) {
				echo esc_html( $author_first_name . ' ' . $author_last_name );
			} else {
				echo esc_html( $author_name );
			}
			?>
		</div>
		<div class="single-post-author-bio__bio">
			<?php echo wp_kses_post( $author_bio ); ?>
		</div>
	</div>
</div>
