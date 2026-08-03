<?php
if ( ! function_exists( 'starter_comment' ) ) {
	function starter_comment( $comment, $args, $depth ) {
		$tag       = ( 'div' === $args['style'] ) ? 'div' : 'li';
		$add_below = ( 'div' === $args['style'] ) ? 'comment' : 'div-comment';
		?>
		<<?php echo esc_attr( $tag ); ?> <?php comment_class( empty( $args['has_children'] ) ? '' : 'parent' ); ?> id="comment-<?php comment_ID(); ?>">

		<?php if ( 'div' !== $args['style'] ) : ?>
			<div id="div-comment-<?php comment_ID(); ?>" class="comment-body">
		<?php endif; ?>

			<?php if ( 0 !== $args['avatar_size'] ) : ?>
				<div class="comment-author-avatar">
					<?php
					$custom_avatar = get_user_meta( $comment->user_id, 'stm_lms_user_avatar', true );

					if ( ! empty( $custom_avatar ) ) {
						echo '<img src="' . esc_url( $custom_avatar ) . '" alt="' . esc_attr( get_the_author_meta( 'display_name', $comment->user_id ) ) . '" width="78" height="78">';
					} else {
						echo get_avatar( $comment, 78 );
					}
					?>
				</div>
			<?php endif; ?>

			<div class="comment-info">
				<div class="comment-author">
					<span class="comment-author-name"><?php echo wp_kses_post( get_comment_author() ); ?></span>
					<span class="comment-date">
						<?php printf( esc_html__( '%1$s at %2$s', 'starter-text-domain' ), esc_html( get_comment_date() ), esc_html( get_comment_time() ) ); ?>
					</span>
					<div class="comment-meta">
						<?php
						comment_reply_link(
							array_merge(
								$args,
								array(
									'reply_text' => esc_html__( 'Reply', 'starter-text-domain' ),
									'add_below'  => $add_below,
									'depth'      => $depth,
									'max_depth'  => $args['max_depth'],
								)
							)
						);
						?>

						<?php edit_comment_link( esc_html__( 'Edit', 'starter-text-domain' ), '  ', '' ); ?>
					</div>
				</div>

				<div class="comment-text">
					<?php comment_text(); ?>
				</div>

				<?php if ( '0' === $comment->comment_approved ) : ?>
					<em class="comment-awaiting-moderation"><?php esc_html_e( 'Your comment is awaiting moderation.', 'starter-text-domain' ); ?></em>
				<?php endif; ?>
			</div>

		<?php if ( 'div' !== $args['style'] ) : ?>
			</div><!-- .comment-body -->
		<?php endif; ?>

		</<?php echo esc_attr( $tag ); ?>>
		<?php
	}
}

add_filter( 'comment_form_default_fields', 'starter_comment_form_fields' );

function starter_comment_form_fields( $fields ) {
	$commenter = wp_get_current_commenter();
	$req       = get_option( 'require_name_email' );
	$aria_req  = ( $req ? " aria-required='true'" : '' );
	$html5     = current_theme_supports( 'html5', 'comment-form' ) ? 1 : 0;
	$fields    = array(
		'author' => '<div class="starter-row">
			<div class="stm-col stm-col-sm-6">
				<div class="input-group comment-form-author">
					<label>' . esc_attr__( 'Name', 'starter-text-domain' ) . '
						<input placeholder="' . esc_attr__( 'Name', 'starter-text-domain' ) . ( $req ? ' *' : '' ) . '" class="form-control" name="author" type="text" value="' . esc_attr( $commenter['comment_author'] ) . '" size="30"' . $aria_req . ' />
						<span style="display: none;">' . esc_html__( 'Name is required', 'starter-text-domain' ) . '</span>
					</label>
				</div>
			</div>',
		'email'  => '<div class="stm-col stm-col-sm-6">
				<div class="input-group comment-form-email">
					<label>' . esc_attr__( 'E-mail', 'starter-text-domain' ) . '
						<input placeholder="' . esc_attr__( 'E-mail', 'starter-text-domain' ) . ( $req ? ' *' : '' ) . '" class="form-control" name="email" ' . ( $html5 ? 'type="email"' : 'type="text"' ) . ' value="' . esc_attr( $commenter['comment_author_email'] ) . '" size="30"' . $aria_req . ' />
						<span style="display: none;">' . esc_html__( 'E-mail is required', 'starter-text-domain' ) . '</span>
					</label>
				</div>
			</div></div>',
	);

	return $fields;
}

add_filter( 'comment_form_defaults', 'starter_comment_form' );

function starter_comment_form( $args ) {
	$args['comment_field'] = '<div class="comment-form-comment">
		<div class="input-group">
			<label>' . esc_attr__( 'Comment', 'starter-text-domain' ) . '
				<textarea placeholder="' . esc_html__( 'Your Comment', 'starter-text-domain' ) . ' *" class="form-control" name="comment" rows="9" aria-required="true"></textarea>
				<span style="display: none;">' . esc_html__( 'Comment is required', 'starter-text-domain' ) . '</span>
			</label>
		</div>
	</div>';

	$args['submit_button'] = '<button name="%1$s" type="submit" id="%2$s" class="%3$s starter-button" value="%4$s">%4$s</button>';

	return $args;
}

add_filter( 'comment_form_fields', 'starter_move_comment_field_to_bottom' );

function starter_move_comment_field_to_bottom( $fields ) {
	$comment_field = $fields['comment'];
	unset( $fields['comment'] );
	$fields['comment'] = $comment_field;

	return $fields;
}
