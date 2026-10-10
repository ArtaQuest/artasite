<?php
namespace AQ;

defined( 'ABSPATH' ) || exit;

/**
 * Per-post share images, rendered server-side with GD and cached in uploads/aq-share/:
 *   og    1200×630   — og:image / twitter:image (X, LinkedIn, Facebook, WhatsApp unfurls)
 *   feed  1080×1350  — an Instagram feed post
 *   story 1080×1920  — an Instagram Story
 * Each card carries the post text, the author (name + @handle), the post's first photo when it has
 * one, and an artaquest.com footer, in brand style (logo blue #1746DC, gold #E8B923). The cache key
 * is a hash of everything drawn, so an edited post gets a new file and URL; unchanged posts are
 * rendered once. Fonts (Inter, OFL) ship with the plugin, so the look never depends on the host.
 */
class ShareCard {
	const VERSION = '2'; // 2: no URL footer, no URLs in the text
	const FORMATS = [ 'og' => [ 1200, 630 ], 'feed' => [ 1080, 1350 ], 'story' => [ 1080, 1920 ] ];
	const BLUE    = [ 0x17, 0x46, 0xDC ];
	const GOLD    = [ 0xE8, 0xB9, 0x23 ];
	const BG      = [ 0x0B, 0x0E, 0x16 ];
	const INK     = [ 0xF2, 0xF3, 0xF6 ];
	const DIM     = [ 0xA4, 0xAA, 0xB8 ];

	/** REST: GET share-card/<id>/<fmt> → 302 to the cached PNG (rendered on first ask). */
	public static function rest( $req ) {
		$id  = (int) $req['id'];
		$fmt = (string) $req['fmt'];
		$url = self::url( $id, $fmt );
		if ( '' === $url ) { return new \WP_Error( 'aq_not_found', 'No share card for that post.', [ 'status' => 404 ] ); }
		$res = new \WP_REST_Response( null, 302 );
		$res->header( 'Location', $url );
		$res->header( 'Cache-Control', 'public, max-age=300' );
		return $res;
	}

	/** Absolute https URL of the post's card in $fmt, rendering it if needed; '' when impossible. */
	public static function url( $id, $fmt = 'og' ) {
		if ( ! isset( self::FORMATS[ $fmt ] ) || ! function_exists( 'imagecreatetruecolor' ) || ! function_exists( 'imagettftext' ) ) { return ''; }
		$p = Notebook::post_public( (int) $id );
		if ( ! $p ) { return ''; }
		$d = self::data( $p );
		$key  = substr( md5( wp_json_encode( [ self::VERSION, $fmt, $d ] ) ), 0, 12 );
		$up   = wp_upload_dir( null, false );
		$dir  = trailingslashit( $up['basedir'] ) . 'aq-share';
		$name = (int) $id . '-' . $fmt . '-' . $key . '.png';
		$file = $dir . '/' . $name;
		if ( ! file_exists( $file ) ) {
			wp_mkdir_p( $dir );
			$png = self::render( $d, $fmt );
			if ( '' === $png ) { return ''; }
			$tmp = $file . '.' . wp_generate_password( 6, false ) . '.tmp';
			if ( false === file_put_contents( $tmp, $png ) || ! rename( $tmp, $file ) ) { @unlink( $tmp ); return ''; }
		}
		return set_url_scheme( trailingslashit( $up['baseurl'] ) . 'aq-share/' . $name, 'https' );
	}

	/** What a card shows, from a post_public() row. */
	public static function data( array $p ) {
		$photo = '';
		foreach ( (array) ( $p['media'] ?? [] ) as $m ) {
			$mime = (string) ( $m['mime'] ?? '' );
			if ( 0 === strpos( $mime, 'image/' ) && 'image/svg+xml' !== $mime && '' !== (string) ( $m['url'] ?? '' ) ) { $photo = (string) $m['url']; break; }
		}
		$a = (array) ( $p['author'] ?? [] );
		return [
			'id'     => (int) ( $p['id'] ?? 0 ),
			'text'   => self::clean( (string) ( $p['body'] ?? '' ) ),
			'name'   => self::clean( (string) ( $a['name'] ?? 'Member' ) ),
			'handle' => (string) ( $a['slug'] ?? '' ),
			'photo'  => $photo,
		];
	}

	/** Plain text GD can draw: markdown links → label, no markup, no emoji (Inter has none), folded. */
	public static function clean( $t ) {
		$t = preg_replace( '/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/', '$1', $t );
		$t = wp_strip_all_tags( (string) $t );
		$t = self::strip_urls( (string) $t );
		$t = preg_replace( '/[*_`#>]+/', '', $t );
		$t = preg_replace( '/[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{FE00}-\x{FE0F}\x{200D}\x{E0000}-\x{E007F}]/u', '', (string) $t );
		return trim( preg_replace( '/\s+/u', ' ', (string) $t ) );
	}

	/** No visible URLs: bare https://…, www.… and domain/path forms are dropped (display only). */
	public static function strip_urls( $t ) {
		$t = preg_replace( '~\b(?:https?://|www\.)[^\s<>()"“”]+~iu', '', (string) $t );
		$t = preg_replace( '~(^|[\s(“"\'])(?:[a-z0-9-]+\.)+[a-z]{2,}/[^\s<>()"“”]*~iu', '$1', (string) $t );
		$t = preg_replace( '~[ \t]+([.,;:!?])~u', '$1', (string) $t );
		return trim( preg_replace( '~\s{2,}~u', ' ', (string) $t ) );
	}

	private static function font( $bold ) {
		return AQ_DIR . '/assets/fonts/Inter-' . ( $bold ? 'Bold' : 'Regular' ) . '.ttf';
	}

	/** Greedy word wrap at $px wide; at most $max lines, the last one ends in "…" if text remains. */
	public static function wrap( $text, $size, $font, $px, $max ) {
		$words = preg_split( '/\s+/u', trim( $text ), -1, PREG_SPLIT_NO_EMPTY );
		$lines = [];
		$cur   = '';
		$w     = function ( $s ) use ( $size, $font ) { $b = imagettfbbox( $size, 0, $font, $s ); return abs( $b[2] - $b[0] ); };
		foreach ( $words as $i => $word ) {
			$try = '' === $cur ? $word : $cur . ' ' . $word;
			if ( $w( $try ) <= $px || '' === $cur ) { $cur = $try; continue; }
			$lines[] = $cur;
			$cur     = $word;
			if ( count( $lines ) === $max ) { $cur = ''; break; }
		}
		if ( '' !== $cur ) { $lines[] = $cur; }
		$all = implode( ' ', $words );
		if ( count( $lines ) > $max || mb_strlen( implode( ' ', array_slice( $lines, 0, $max ) ) ) < mb_strlen( $all ) ) {
			$lines = array_slice( $lines, 0, $max );
			$last  = $lines[ $max - 1 ] ?? '';
			while ( '' !== $last && $w( $last . '…' ) > $px ) { $last = mb_substr( $last, 0, -1 ); }
			$lines[ $max - 1 ] = rtrim( $last, " ,.;:" ) . '…';
		}
		return $lines;
	}

	/** The largest size in $sizes whose wrap fits $px wide and $height tall (line height $lh×size);
	 *  else the smallest size, truncated to the lines that fit. */
	public static function fit( $text, $font, $px, $sizes, $height, $lh = 1.36 ) {
		foreach ( $sizes as $s ) {
			$l = self::wrap( $text, $s, $font, $px, 99 );
			if ( count( $l ) * $s * $lh <= $height ) { return [ $s, $l ]; }
		}
		$s = end( $sizes );
		return [ $s, self::wrap( $text, $s, $font, $px, max( 1, (int) floor( $height / ( $s * $lh ) ) ) ) ];
	}

	private static function photo( $url ) {
		if ( '' === $url ) { return null; }
		$abs = 0 === strpos( $url, '/' ) ? home_url( $url ) : $url;
		$r   = wp_safe_remote_get( $abs, [ 'timeout' => 10, 'limit_response_size' => 8 * 1024 * 1024 ] );
		if ( is_wp_error( $r ) || 200 !== (int) wp_remote_retrieve_response_code( $r ) ) { return null; }
		$im = @imagecreatefromstring( (string) wp_remote_retrieve_body( $r ) );
		return $im ?: null;
	}

	/** Copy $src into the box (x,y,w,h), cover-cropped, with rounded corners of radius $r. */
	private static function cover( $dst, $src, $x, $y, $w, $h, $r, $bg ) {
		$sw = imagesx( $src ); $sh = imagesy( $src );
		// Crop at most ~20% of the photo: a box much wider/taller than the photo narrows to suit it.
		$ar = $sw / $sh;
		if ( $w / $h > $ar * 1.25 ) { $nw = (int) round( $h * $ar * 1.25 ); $x += (int) ( ( $w - $nw ) / 2 ); $w = $nw; }
		elseif ( $w / $h < $ar / 1.25 ) { $nh = (int) round( $w / $ar / 1.25 ); $y += (int) ( ( $h - $nh ) / 2 ); $h = $nh; }
		$scale = max( $w / $sw, $h / $sh );
		$cw = (int) round( $w / $scale ); $ch = (int) round( $h / $scale );
		$sx = (int) max( 0, ( $sw - $cw ) / 2 );
		$sy = (int) max( 0, ( $sh - $ch ) / 2.6 ); // faces sit high: crop a little more from the bottom
		imagecopyresampled( $dst, $src, $x, $y, $sx, $sy, $w, $h, $cw, $ch );
		for ( $i = 0; $i < $r; $i++ ) { // round the corners by painting the background outside the arc
			$d = $r - (int) round( sqrt( $r * $r - ( $r - $i ) * ( $r - $i ) ) );
			foreach ( [ $y + $i, $y + $h - 1 - $i ] as $yy ) {
				imageline( $dst, $x, $yy, $x + $d - 1, $yy, $bg );
				imageline( $dst, $x + $w - $d, $yy, $x + $w - 1, $yy, $bg );
			}
		}
	}

	/** Draws the two-colour wordmark; returns its right edge. */
	private static function wordmark( $im, $x, $y, $size, $gold, $blue ) {
		$f = self::font( true );
		$b = imagettftext( $im, $size, 0, $x, $y, $gold, $f, 'Arta' );
		$c = imagettftext( $im, $size, 0, $b[2], $y, $blue, $f, 'Quest' );
		return $c[2];
	}

	/** PNG bytes for $d in $fmt; '' on failure. */
	public static function render( array $d, $fmt ) {
		[ $W, $H ] = self::FORMATS[ $fmt ];
		$im = imagecreatetruecolor( $W, $H );
		$c  = function ( $rgb ) use ( $im ) { return imagecolorallocate( $im, $rgb[0], $rgb[1], $rgb[2] ); };
		$bg = $c( self::BG ); $blue = $c( self::BLUE ); $gold = $c( self::GOLD ); $ink = $c( self::INK ); $dim = $c( self::DIM );
		imagefilledrectangle( $im, 0, 0, $W, $H, $bg );
		$bold = self::font( true ); $reg = self::font( false );
		$photo = self::photo( $d['photo'] );
		$text  = '' !== $d['text'] ? $d['text'] : 'A post on ArtaQuest';
		$who   = $d['name'];
		$at    = '' !== $d['handle'] ? '@' . $d['handle'] : '';

		if ( 'og' === $fmt ) {
			imagefilledrectangle( $im, 0, 0, 13, $H, $blue ); // logo-blue spine
			$pad = 72; $tx = $pad; $tw = $photo ? 640 : $W - 2 * $pad;
			if ( $photo ) { self::cover( $im, $photo, $W - 420 - 48, 48, 420, $H - 96, 28, $bg ); }
			imagettftext( $im, 30, 0, $tx, 116, $ink, $bold, $who );
			if ( '' !== $at ) { $bb = imagettfbbox( 30, 0, $bold, $who ); imagettftext( $im, 26, 0, $tx + abs( $bb[2] - $bb[0] ) + 16, 116, $dim, $reg, $at ); }
			[ $s, $lines ] = self::fit( $text, $bold, $tw, [ 52, 46, 40, 34, 30, 26 ], $H - 130 - 170, 1.3 );
			$y = 170 + $s;
			foreach ( $lines as $l ) { imagettftext( $im, $s, 0, $tx, $y, $ink, $bold, $l ); $y += (int) round( $s * 1.3 ); }
			self::wordmark( $im, $tx, $H - 56, 30, $gold, $blue );
		} else {
			$pad = 88; $tw = $W - 2 * $pad;
			imagefilledrectangle( $im, 0, 0, $W, 14, $blue );
			$top = 'story' === $fmt ? 230 : 150;
			imagettftext( $im, 40, 0, $pad, $top, $ink, $bold, $who );
			if ( '' !== $at ) { imagettftext( $im, 32, 0, $pad, $top + 58, $dim, $reg, $at ); }
			$y = $top + 140;
			$foot = 'story' === $fmt ? $H - 260 : $H - 130;
			$room = $foot - 70 - $y;
			[ $s, $lines ] = self::fit( $text, $bold, $tw, [ 64, 56, 50, 44, 40, 36 ], $photo ? (int) ( $room * 0.38 ) : $room );
			$y += $s;
			foreach ( $lines as $l ) { imagettftext( $im, $s, 0, $pad, $y, $ink, $bold, $l ); $y += (int) round( $s * 1.36 ); }
			if ( $photo ) {
				$py = $y + 20; $ph = $foot - 70 - $py;
				if ( $ph > 200 ) { self::cover( $im, $photo, $pad, $py, $tw, $ph, 36, $bg ); }
			}
			imagefilledrectangle( $im, $pad, $foot - 34, $W - $pad, $foot - 32, $c( [ 0x2A, 0x2F, 0x3C ] ) );
			self::wordmark( $im, $pad, $foot + 34, 40, $gold, $blue );
		}
		if ( $photo ) { imagedestroy( $photo ); }
		ob_start();
		imagepng( $im, null, 6 );
		imagedestroy( $im );
		return (string) ob_get_clean();
	}
}
