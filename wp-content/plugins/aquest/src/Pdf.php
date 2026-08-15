<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * A PDF writer in about three hundred lines, with no library behind it.
 *
 * WHY THIS EXISTS. The plugin is dependency-free by design — no Composer, no vendor directory —
 * and WordPress.com Atomic fixes the PHP environment, so there is no pdftotext, no Ghostscript and
 * no escape hatch to shell out to. A year-end filing package that only exists as a web page is not
 * something anyone can put in an envelope, so the alternative to this file is no PDF at all.
 *
 * WHAT MAKES IT SMALL ENOUGH TO HAND-WRITE. PDF is only hard when you embed fonts. Every PDF reader
 * ever made ships the fourteen standard Type1 faces, so referencing Helvetica costs one dictionary
 * and zero font data. Text-only documents with rules and right-aligned figures — which is exactly
 * what a financial statement is — need no images, no transparency and no compression.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: images, colour beyond greyscale, embedded or non-Latin fonts,
 * links, tables with borders, or any encoding but WinAnsi. Anything needing those wants a real
 * library and a dependency budget this plugin does not have.
 *
 * THE ENCODING TRAP, and it is the one that bites. The standard fonts are single-byte WinAnsi. Every
 * string here arrives as UTF-8 from a database that is full of typographic dashes, curly quotes and
 * the ArtaCoin sign. Passing those through raw emits mojibake in a document nobody proof-reads
 * because it is generated — so text() transliterates to WinAnsi and replaces what it cannot map,
 * rather than silently writing bytes the reader will mis-decode.
 */
final class Pdf {

	const PAGE_W = 612.0;  // US Letter, in points. CRA forms are Letter, and this sits beside them.
	const PAGE_H = 792.0;
	const MARGIN = 54.0;   // 0.75in — enough for a staple and a filing hole punch.

	/** Advance widths (per 1000 units) for ASCII 32-126, in code-point order. From the Adobe AFMs.
	 *  Needed for word wrapping and right alignment; without real metrics, prose overflows the page
	 *  on any line that happens to be full of wide characters. */
	const W_REG = '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584';
	const W_BOLD = '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584';

	private $pages   = [];   // finished content streams
	private $buf     = '';   // the page being written
	private $y       = 0.0;  // current baseline, measured from the top
	private $title   = '';
	private $footer  = '';
	private $page_no = 0;

	public function __construct( $title = '', $footer = '' ) {
		$this->title  = (string) $title;
		$this->footer = (string) $footer;
		$this->new_page();
	}

	// ── Text encoding ─────────────────────────────────────────────────────────

	/**
	 * UTF-8 → WinAnsi, with the characters this codebase actually produces spelled out rather than
	 * dropped. An em dash becoming a question mark in a filing package is a small thing; the ArtaCoin
	 * sign becoming one in a column of ArtaCoin figures is not.
	 */
	private static function win( $s ) {
		$s = (string) $s;
		$map = [
			'₳' => 'A',  '—' => '-',  '–' => '-',  '’' => "'",  '‘' => "'",
			'“' => '"',  '”' => '"',  '…' => '...', '·' => '-',  '→' => '->',
			'≥' => '>=', '≤' => '<=', '×' => 'x',  '⁄' => '/',  ' ' => ' ',
		];
		$s = strtr( $s, $map );
		if ( function_exists( 'iconv' ) ) {
			$c = @iconv( 'UTF-8', 'Windows-1252//TRANSLIT', $s );
			if ( false !== $c ) { return $c; }
		}
		// No iconv: keep ASCII, drop the rest rather than emit bytes the reader will mis-decode.
		return preg_replace( '/[^\x20-\x7E]/', '', $s );
	}

	/** Escape the three characters that are structural inside a PDF string literal. */
	private static function esc( $s ) {
		return strtr( $s, [ '\\' => '\\\\', '(' => '\\(', ')' => '\\)', "\r" => '' ] );
	}

	/** Rendered width of an already-WinAnsi string, in points. */
	private static function width( $s, $size, $bold = false ) {
		static $reg = null, $bd = null;
		if ( null === $reg ) {
			$reg = array_map( 'intval', explode( ',', self::W_REG ) );
			$bd  = array_map( 'intval', explode( ',', self::W_BOLD ) );
		}
		$t = $bold ? $bd : $reg;
		$w = 0;
		$n = strlen( $s );
		for ( $i = 0; $i < $n; $i++ ) {
			$c = ord( $s[ $i ] );
			// Outside ASCII the metrics table does not apply; 556 is Helvetica's commonest width and
			// is close enough for the accented characters that reach a financial statement.
			$w += ( $c >= 32 && $c <= 126 ) ? $t[ $c - 32 ] : 556;
		}
		return $w * $size / 1000.0;
	}

	/** Public: the width a string will occupy, for callers laying out columns. */
	public function text_width( $s, $size, $bold = false ) {
		return self::width( self::win( $s ), $size, $bold );
	}

	// ── Pages ─────────────────────────────────────────────────────────────────

	private function new_page() {
		if ( '' !== $this->buf ) { $this->pages[] = $this->buf; }
		$this->buf = '';
		$this->y   = self::MARGIN;
		$this->page_no++;
		if ( '' !== $this->title ) {
			$this->put( self::MARGIN, $this->y, $this->title, 8, false, 0.45 );
			$this->y += 6;
			$this->hr( 0.35 );
			$this->y += 10;
		}
	}

	/** Start a new page when $need points would not fit above the bottom margin. */
	public function room( $need ) {
		if ( $this->y + $need > self::PAGE_H - self::MARGIN - 22 ) { $this->new_page(); }
	}

	public function page_break() { $this->new_page(); }

	/** Emit one text run. $y is measured from the TOP; PDF's origin is the bottom left. */
	private function put( $x, $y, $s, $size, $bold = false, $grey = 0.0 ) {
		$s = self::esc( self::win( $s ) );
		$f = $bold ? '/F2' : '/F1';
		$this->buf .= sprintf(
			"BT %s %.1f Tf %.3f g %.2f %.2f Td (%s) Tj ET\n",
			$f, $size, $grey, $x, self::PAGE_H - $y, $s
		);
	}

	// ── Flowing content ───────────────────────────────────────────────────────

	public function h1( $s ) {
		$this->room( 30 );
		$this->y += 8;
		$this->put( self::MARGIN, $this->y, $s, 16, true );
		$this->y += 18;
	}

	public function h2( $s ) {
		$this->room( 26 );
		$this->y += 12;
		$this->put( self::MARGIN, $this->y, $s, 11, true );
		$this->y += 12;
		$this->hr( 0.5 );
		$this->y += 8;
	}

	public function h3( $s ) {
		$this->room( 20 );
		$this->y += 8;
		$this->put( self::MARGIN, $this->y, $s, 9, true, 0.35 );
		$this->y += 12;
	}

	/** Wrapped body text. Returns the height consumed. */
	public function para( $s, $size = 9, $grey = 0.2, $indent = 0 ) {
		$max   = self::PAGE_W - 2 * self::MARGIN - $indent;
		$words = preg_split( '/\s+/', trim( self::win( $s ) ) );
		$line  = '';
		foreach ( $words as $w ) {
			$try = '' === $line ? $w : $line . ' ' . $w;
			if ( self::width( $try, $size ) > $max && '' !== $line ) {
				$this->room( $size + 3 );
				$this->put( self::MARGIN + $indent, $this->y, $line, $size, false, $grey );
				$this->y += $size + 2.5;
				$line = $w;
			} else {
				$line = $try;
			}
		}
		if ( '' !== $line ) {
			$this->room( $size + 3 );
			$this->put( self::MARGIN + $indent, $this->y, $line, $size, false, $grey );
			$this->y += $size + 2.5;
		}
		$this->y += 3;
	}

	/** A horizontal rule at the current position. */
	public function hr( $w = 0.5, $grey = 0.75 ) {
		$this->buf .= sprintf(
			"%.3f G %.2f w %.2f %.2f m %.2f %.2f l S\n",
			$grey, $w, self::MARGIN, self::PAGE_H - $this->y, self::PAGE_W - self::MARGIN, self::PAGE_H - $this->y
		);
	}

	public function gap( $h = 6 ) { $this->y += $h; }

	/** A short ruled line to sign or date on, with its caption underneath. */
	public function sign_line( $caption, $width = 210, $x = null ) {
		$this->room( 34 );
		$x  = ( null === $x ) ? self::MARGIN : $x;
		$this->y += 16;
		$this->buf .= sprintf(
			"0.35 G 0.6 w %.2f %.2f m %.2f %.2f l S\n",
			$x, self::PAGE_H - $this->y, $x + $width, self::PAGE_H - $this->y
		);
		$this->y += 10;
		$this->put( $x, $this->y, $caption, 7.5, false, 0.5 );
		$this->y += 12;
	}

	/**
	 * A label on the left and a right-aligned figure on the right — the shape every line of a
	 * financial statement takes. $note prints small and grey under the label.
	 */
	public function row( $label, $amount, $bold = false, $note = '', $indent = 0 ) {
		$this->room( $note ? 24 : 15 );
		$size = 9;
		$this->put( self::MARGIN + $indent, $this->y, $label, $size, $bold, $bold ? 0.0 : 0.15 );
		$a = self::win( (string) $amount );
		$this->put( self::PAGE_W - self::MARGIN - self::width( $a, $size, $bold ), $this->y, $amount, $size, $bold );
		$this->y += 12;
		if ( '' !== $note ) {
			$this->put( self::MARGIN + $indent + 8, $this->y, $note, 7.5, false, 0.5 );
			$this->y += 10;
		}
	}

	/** A form field: its CRA line number, its label, and the value to enter. */
	public function field( $line, $label, $value ) {
		$this->room( 15 );
		$this->put( self::MARGIN, $this->y, $line, 9, true, 0.35 );
		$this->put( self::MARGIN + 34, $this->y, $label, 9, false, 0.15 );
		$v = self::win( (string) $value );
		$this->put( self::PAGE_W - self::MARGIN - self::width( $v, 9, true ), $this->y, $value, 9, true );
		$this->y += 13;
	}

	/** Two columns of small key/value text — for a cover block. */
	public function kv( $k, $v ) {
		$this->room( 14 );
		$this->put( self::MARGIN, $this->y, $k, 8.5, false, 0.45 );
		$this->put( self::MARGIN + 150, $this->y, $v, 8.5, true );
		$this->y += 12;
	}

	public function bullet( $s ) {
		$this->room( 14 );
		$this->put( self::MARGIN + 4, $this->y, '-', 9, false, 0.35 );
		$this->para( $s, 9, 0.2, 16 );
	}

	// ── Output ────────────────────────────────────────────────────────────────

	/**
	 * Assemble the file. The xref table is a list of BYTE OFFSETS, so every object is built into a
	 * string first and measured as it is appended — computing them any other way is how a PDF ends
	 * up opening in one reader and not another.
	 */
	public function output() {
		if ( '' !== $this->buf ) { $this->pages[] = $this->buf; }
		$this->buf = '';
		$n     = count( $this->pages );
		$total = $n;

		// Stamp the footer and page numbers now that the count is known.
		foreach ( $this->pages as $i => $content ) {
			$foot = trim( $this->footer );
			$num  = 'Page ' . ( $i + 1 ) . ' of ' . $total;
			// PDF's origin is the BOTTOM-left, so a footer is a SMALL y. Deriving it from PAGE_H the
			// way the flowing layout does put it at the top of the page, above the running head.
			$y    = self::MARGIN - 18;
			$line = sprintf( "%.3f G 0.35 w %.2f %.2f m %.2f %.2f l S\n", 0.8, self::MARGIN, $y + 12, self::PAGE_W - self::MARGIN, $y + 12 );
			$fs   = self::esc( self::win( $foot ) );
			$ns   = self::esc( self::win( $num ) );
			$nw   = self::width( self::win( $num ), 7.5 );
			$content .= $line
				. sprintf( "BT /F1 7.5 Tf 0.5 g %.2f %.2f Td (%s) Tj ET\n", self::MARGIN, $y, $fs )
				. sprintf( "BT /F1 7.5 Tf 0.5 g %.2f %.2f Td (%s) Tj ET\n", self::PAGE_W - self::MARGIN - $nw, $y, $ns );
			$this->pages[ $i ] = $content;
		}

		// Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, then per page (page dict, content).
		$objs    = [];
		$objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
		$kids    = [];
		for ( $i = 0; $i < $n; $i++ ) { $kids[] = ( 5 + $i * 2 ) . ' 0 R'; }
		$objs[2] = "<< /Type /Pages /Kids [" . implode( ' ', $kids ) . "] /Count {$n} >>";
		$objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
		$objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
		for ( $i = 0; $i < $n; $i++ ) {
			$pid = 5 + $i * 2;
			$cid = $pid + 1;
			$objs[ $pid ] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " . self::PAGE_W . ' ' . self::PAGE_H . "]"
				. " /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {$cid} 0 R >>";
			$stream = $this->pages[ $i ];
			$objs[ $cid ] = "<< /Length " . strlen( $stream ) . " >>\nstream\n" . $stream . "endstream";
		}

		$out     = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
		$offsets = [];
		ksort( $objs );
		foreach ( $objs as $id => $body ) {
			$offsets[ $id ] = strlen( $out );
			$out .= "{$id} 0 obj\n{$body}\nendobj\n";
		}
		$max      = max( array_keys( $objs ) );
		$xref_pos = strlen( $out );
		$out     .= "xref\n0 " . ( $max + 1 ) . "\n0000000000 65535 f \n";
		for ( $id = 1; $id <= $max; $id++ ) {
			$out .= isset( $offsets[ $id ] )
				? sprintf( "%010d 00000 n \n", $offsets[ $id ] )
				: "0000000000 65535 f \n";
		}
		$out .= "trailer\n<< /Size " . ( $max + 1 ) . " /Root 1 0 R"
			. ( '' !== $this->title ? " /Info << /Title (" . self::esc( self::win( $this->title ) ) . ") /Producer (ArtaQuest) >>" : '' )
			. " >>\nstartxref\n{$xref_pos}\n%%EOF\n";
		return $out;
	}
}
