<?php
namespace ATR;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/** Admin review page (manage_options). Decisions post to admin-post.php with a nonce. */
class Admin {
	const SLUG  = 'artatask-review';
	const NONCE = 'atr_decide';

	public static function boot() {
		add_action( 'admin_menu', [ self::class, 'menu' ] );
		add_action( 'admin_post_atr_decide', [ self::class, 'handle' ] );
	}

	public static function menu() {
		add_menu_page( 'ArtaTask Review', 'ArtaTask Review', 'manage_options', self::SLUG, [ self::class, 'render' ], 'dashicons-groups', 58 );
	}

	private static function photo_url( $p ) {
		if ( $p === '' ) { return ''; }
		if ( preg_match( '#^https?://#i', $p ) ) { return $p; }
		$up = wp_upload_dir();
		return trailingslashit( $up['baseurl'] ) . ltrim( $p, '/' );
	}

	private static function fmt_dur( $s ) {
		if ( $s === null ) { return ''; }
		if ( $s < 3600 ) { return round( $s / 60 ) . ' min'; }
		if ( $s < 172800 ) { return round( $s / 3600, 1 ) . ' h'; }
		return round( $s / 86400, 1 ) . ' d';
	}

	public static function handle() {
		if ( ! current_user_can( 'manage_options' ) ) { wp_die( 'Forbidden', 403 ); }
		check_admin_referer( self::NONCE );
		$action = sanitize_key( $_POST['atr_action'] ?? '' );
		if ( $action === '' || $action === '-1' ) { $action = sanitize_key( $_POST['atr_action2'] ?? '' ); }
		$ids = array_map( 'intval', (array) ( $_POST['ids'] ?? [] ) );
		if ( isset( $_POST['atr_one'] ) ) {
			[ $one_action, $one_id ] = array_pad( explode( ':', sanitize_text_field( wp_unslash( $_POST['atr_one'] ) ) ), 2, 0 );
			$action = sanitize_key( $one_action );
			$ids    = [ (int) $one_id ];
		}
		$map = [ 'include' => 'included', 'exclude' => 'excluded', 'reset' => 'pending' ];
		$n   = 0;
		if ( isset( $map[ $action ] ) ) {
			$n = Store::decide( $ids, $map[ $action ] );
		} elseif ( $action === 'notes' && isset( $_POST['notes_id'] ) ) {
			Store::set_notes( (int) $_POST['notes_id'], wp_unslash( $_POST['notes'] ?? '' ) );
			$n = 1;
		}
		$back = wp_get_referer() ?: admin_url( 'admin.php?page=' . self::SLUG );
		wp_safe_redirect( add_query_arg( 'atr_done', $n, $back ) );
		exit;
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) { wp_die( 'Forbidden', 403 ); }
		$platform = sanitize_key( $_GET['platform'] ?? '' );
		$status   = sanitize_key( $_GET['status'] ?? 'pending' );
		$before   = (int) ( $_GET['before'] ?? 0 );
		$rows     = Store::page( $platform, $status, $before );
		$counts   = Store::counts();
		$base     = admin_url( 'admin.php?page=' . self::SLUG );
		?>
		<div class="wrap">
		<h1>ArtaTask Review</h1>
		<p>Accounts the platforms suggested. Include one to add it to the study (the phone will send a request); exclude to drop it. Nothing is sent from this page.</p>
		<?php if ( isset( $_GET['atr_done'] ) ) : ?>
			<div class="notice notice-success is-dismissible"><p><?php echo (int) $_GET['atr_done']; ?> updated.</p></div>
		<?php endif; ?>
		<ul class="subsubsub">
			<?php foreach ( array_merge( [ 'all' => array_sum( $counts ) ], $counts ) as $s => $n ) : ?>
				<li><a href="<?php echo esc_url( add_query_arg( [ 'status' => $s, 'platform' => $platform ], $base ) ); ?>" <?php echo $s === $status ? 'class="current"' : ''; ?>><?php echo esc_html( ucfirst( $s ) ); ?> <span class="count">(<?php echo (int) $n; ?>)</span></a> |</li>
			<?php endforeach; ?>
		</ul>
		<form method="get" style="clear:both;margin:8px 0">
			<input type="hidden" name="page" value="<?php echo esc_attr( self::SLUG ); ?>">
			<input type="hidden" name="status" value="<?php echo esc_attr( $status ); ?>">
			<select name="platform">
				<option value="">All platforms</option>
				<?php foreach ( Store::PLATFORMS as $p ) : ?>
					<option value="<?php echo esc_attr( $p ); ?>" <?php selected( $platform, $p ); ?>><?php echo esc_html( $p === 'x' ? 'X' : ucfirst( $p ) ); ?></option>
				<?php endforeach; ?>
			</select>
			<?php submit_button( 'Filter', 'secondary', '', false ); ?>
		</form>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="atr_decide">
			<?php wp_nonce_field( self::NONCE ); ?>
			<div class="tablenav top"><div class="alignleft actions bulkactions">
				<select name="atr_action"><option value="-1">Bulk actions</option><option value="include">Include in study</option><option value="exclude">Exclude</option><option value="reset">Back to pending</option></select>
				<?php submit_button( 'Apply', 'action', '', false ); ?>
			</div></div>
			<table class="wp-list-table widefat fixed striped">
			<thead><tr>
				<td class="manage-column column-cb check-column"><input type="checkbox" onclick="document.querySelectorAll('.atr-cb').forEach(c=>c.checked=this.checked)"></td>
				<th style="width:56px">Photo</th><th>Name / handle</th><th>Tagline &amp; bio</th>
				<th style="width:150px">Counts</th><th style="width:90px">Status</th><th style="width:170px">Dates</th><th style="width:150px">Decide</th>
			</tr></thead><tbody>
			<?php if ( ! $rows ) : ?><tr><td colspan="8">Nothing here.</td></tr><?php endif; ?>
			<?php foreach ( $rows as $r ) :
				$img = self::photo_url( $r['photo'] );
				$tta = self::fmt_dur( Store::time_to_accept( $r ) );
				?>
				<tr>
					<th class="check-column"><input class="atr-cb" type="checkbox" name="ids[]" value="<?php echo (int) $r['id']; ?>"></th>
					<td><?php if ( $img ) : ?><img src="<?php echo esc_url( $img ); ?>" width="48" height="48" style="border-radius:50%;object-fit:cover" alt="" loading="lazy" referrerpolicy="no-referrer"><?php endif; ?></td>
					<td><strong><?php echo esc_html( $r['full_name'] ?: $r['handle'] ); ?></strong><br>
						<?php echo esc_html( $r['platform'] === 'x' ? 'X' : ucfirst( $r['platform'] ) ); ?> ·
						<?php if ( $r['profile_url'] ) : ?><a href="<?php echo esc_url( $r['profile_url'] ); ?>" target="_blank" rel="noopener noreferrer">@<?php echo esc_html( $r['handle'] ); ?></a><?php else : ?>@<?php echo esc_html( $r['handle'] ); ?><?php endif; ?>
						<br><small><?php echo esc_html( $r['source'] ); ?></small></td>
					<td><em><?php echo esc_html( $r['tagline'] ); ?></em><br><small><?php echo esc_html( wp_trim_words( (string) $r['bio'], 40 ) ); ?></small>
						<?php if ( $r['notes'] ) : ?><br><small><b>Notes:</b> <?php echo esc_html( $r['notes'] ); ?></small><?php endif; ?></td>
					<td><small>
						<?php foreach ( [ 'mutuals' => 'Mutuals', 'followers' => 'Followers', 'following' => 'Following', 'connections' => 'Connections' ] as $k => $label ) :
							if ( $r[ $k ] !== null ) { echo esc_html( $label . ': ' . number_format_i18n( (int) $r[ $k ] ) ) . '<br>'; }
						endforeach; ?></small></td>
					<td><?php echo esc_html( $r['status'] ); ?></td>
					<td><small>Found <?php echo esc_html( get_date_from_gmt( $r['discovered_at'], 'Y-m-d H:i' ) ); ?>
						<?php if ( $r['decided_at'] ) : ?><br>Decided <?php echo esc_html( get_date_from_gmt( $r['decided_at'], 'Y-m-d H:i' ) ); ?><?php endif; ?>
						<?php if ( $r['request_sent_at'] ) : ?><br>Sent <?php echo esc_html( get_date_from_gmt( $r['request_sent_at'], 'Y-m-d H:i' ) ); ?><?php endif; ?>
						<?php if ( $r['accepted_at'] ) : ?><br>Accepted <?php echo esc_html( get_date_from_gmt( $r['accepted_at'], 'Y-m-d H:i' ) . ' (' . $tta . ')' ); ?><?php endif; ?></small></td>
					<td><?php if ( ! $r['request_sent_at'] ) : ?>
						<?php if ( $r['status'] !== 'included' ) : ?><button class="button button-primary button-small" name="atr_one" value="include:<?php echo (int) $r['id']; ?>">Include</button><?php endif; ?>
						<?php if ( $r['status'] !== 'excluded' ) : ?><button class="button button-small" name="atr_one" value="exclude:<?php echo (int) $r['id']; ?>">Exclude</button><?php endif; ?>
						<?php else : ?><small>Request sent</small><?php endif; ?></td>
				</tr>
			<?php endforeach; ?>
			</tbody></table>
		</form>
		<?php if ( count( $rows ) >= Store::PER_PAGE ) :
			$last = end( $rows ); ?>
			<p><a class="button" href="<?php echo esc_url( add_query_arg( [ 'status' => $status, 'platform' => $platform, 'before' => (int) $last['id'] ], $base ) ); ?>">Older →</a></p>
		<?php endif; ?>
		</div>
		<?php
	}
}
