<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * THE SVG SANITISER — the publish-time gate for the one artifact type a browser EXECUTES.
 *
 * WHY THIS EXISTS AT ALL (measured 2026-07-30, do not re-litigate). A procedural animation shipped
 * as a pre-rendered video is destroyed by DISPLAY SCALING, not by the codec: a 1080px-wide video in
 * a ~430px feed card thins a 9px hairline to 3.6px and loses 58% of the direction signal the effect
 * depends on, and no encode setting fixes it because the same card is 430px on one device and
 * 1290px on another. An animated SVG in an <img> holds the hairline CONSTANT at every card size and
 * every devicePixelRatio via vector-effect="non-scaling-stroke" (verified in Chrome at 430@1x,
 * 430@2x, 430@3x, 600 and 1080), matches the notebook's computed ground truth to 2/255 across 25
 * probes, and costs 14.9 KB against 599 KB for the webm it replaces. So the work itself is now a
 * vector scene, and the platform has to be able to publish one safely.
 *
 * WHAT MAKES IT DANGEROUS. Scripts inside an <img>-embedded SVG do not execute — verified in Chrome
 * across five configurations — but <img> safety does not survive a TOP-LEVEL NAVIGATION. The same
 * file, opened directly at its own URL, is a document, and a document runs its scripts with the
 * serving origin's authority. On top of that: uploads responses on this host carry no
 * `X-Content-Type-Options` and there is nowhere on WP.com Atomic to add one to a static nginx path,
 * and the published bytes are ATTACKER-INFLUENCED — any member may submit any public Kaggle
 * notebook, and its author chose every byte of its output. And an external reference of any kind
 * inside an SVG (href, xlink:href, @import, url() to a remote host) is a TRACKING BEACON fired on
 * every single feed impression, because the page CSP allows img-src https:.
 *
 * THE SHAPE OF THE DEFENCE — copy-out, never filter-in. This is a strict ALLOW-LIST, for exactly
 * the reason Media::ORIGIN_SERVABLE is one: a deny-list has to anticipate every construct a browser
 * will execute and is wrong the day it misses one, whereas an allow-list only has to name what a
 * declarative animated scene needs, and an unfamiliar element or attribute FAILS CLOSED. We do not
 * regex-strip the input. We PARSE it and REBUILD a fresh document containing only allow-listed
 * nodes, and the caller publishes OUR serialisation — never the author's bytes. That is what closes
 * the parser-differential (mXSS) class of bug: there is no leftover of the original document for
 * the browser's parser to read differently from ours, because the original document is discarded.
 *
 * clean() is IDEMPOTENT by construction and asserts it: it runs the rebuild twice and refuses
 * anything that does not converge to a fixed point. Media leans on that — it will only write an
 * SVG into the web root when the bytes it is handed are byte-identical to clean()'s own output.
 *
 * ON SMIL (<animate>, <animateTransform>, <set>) — ARGUED, NOT ASSUMED. SMIL is allowed. It is
 * purely declarative, it is one of the two animation vehicles that actually run inside an <img>
 * (the other being CSS in <style>), and refusing it would push authors onto the CSS path for no
 * gain in safety. But SMIL has a real XSS history, and every case of it is the same shape: animate
 * an attribute that holds a URL — `<set attributeName="href" to="javascript:…">`. So SMIL is
 * allowed only with `attributeName` restricted to SMIL_TARGETS, a list of purely presentational and
 * geometric attributes that can never hold a URL or a script, and every from/to/by/values string
 * goes through the same value validation as any other attribute. With the target list enforced,
 * SMIL cannot express the attack; without it, SMIL is a scripting primitive.
 *
 * ON <filter> — REFUSED, and this is not about script. Filter chains are the cheapest way to make a
 * 15 KB file cost a viewer's GPU an unbounded amount of work on every feed impression, and nothing
 * in the measured design needs one. Excluded, and it fails closed like everything else.
 */
final class Svg {

	/** The only namespaces that survive the rebuild. */
	const NS       = 'http://www.w3.org/2000/svg';
	const NS_XLINK = 'http://www.w3.org/1999/xlink';
	const NS_XML   = 'http://www.w3.org/XML/1998/namespace';
	const NS_XMLNS = 'http://www.w3.org/2000/xmlns/';

	/** Ceilings. Every one of these REJECTS — nothing here ever truncates, because a truncated
	 *  drawing is a different drawing and publishing it under the author's name would be a lie. */
	const MAX_BYTES      = 2097152;   // 2 MB of source (scene.svg is 14.9 KB — this is enormously generous)
	const MAX_ELEMENTS   = 6000;      // total elements in the rebuilt document
	const MAX_DEPTH      = 32;        // nesting depth
	const MAX_ATTRS      = 48;        // attributes on any one element
	const MAX_ATTR_BYTES = 262144;    // one attribute value (a long path `d` is the reason it is this big)
	const MAX_TEXT_BYTES = 8192;      // one text node
	const MAX_CSS_BYTES  = 65536;     // ALL <style> elements added together
	/**
	 * <use> is the one allow-listed element whose RENDERED cost is not its SOURCE cost, and the
	 * bounds above all count source. A chain of groups where each references the previous one twice
	 * is flat in <defs> (depth ~3) and a couple of thousand elements — well inside every ceiling —
	 * yet the browser deep-clones 2^n leaves. 60 levels is 3 KB of file and 2^60 rendered nodes, and
	 * it re-renders on EVERY feed impression: the same unbounded per-view cost that <filter> is
	 * refused for. So references are counted and, more importantly, a <use> may not resolve to a
	 * subtree that itself contains a <use> — one level of indirection, which is all a scene needs
	 * and which makes exponential expansion unconstructible rather than merely unlikely.
	 */
	const MAX_USES = 64;

	/**
	 * Elements a declarative animated scene needs, each mapped to the attributes only IT may carry.
	 * Anything not named here is refused outright — including every element in REFUSED below, which
	 * exists purely to give the author a precise reason instead of a generic one.
	 */
	const ELEMENTS = [
		'svg'            => [ 'width', 'height', 'viewBox', 'preserveAspectRatio', 'x', 'y', 'version', 'overflow' ],
		'title'          => [],
		'desc'           => [],
		'defs'           => [],
		'style'          => [ 'type', 'media' ],
		'g'              => [],
		'rect'           => [ 'x', 'y', 'width', 'height', 'rx', 'ry', 'pathLength' ],
		'circle'         => [ 'cx', 'cy', 'r', 'pathLength' ],
		'ellipse'        => [ 'cx', 'cy', 'rx', 'ry', 'pathLength' ],
		'line'           => [ 'x1', 'y1', 'x2', 'y2', 'pathLength' ],
		'polyline'       => [ 'points', 'pathLength' ],
		'polygon'        => [ 'points', 'pathLength' ],
		'path'           => [ 'd', 'pathLength' ],
		'text'           => [ 'x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust' ],
		'tspan'          => [ 'x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust' ],
		'linearGradient' => [ 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'href' ],
		'radialGradient' => [ 'cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'href' ],
		'stop'           => [ 'offset', 'stop-color', 'stop-opacity' ],
		'clipPath'       => [ 'clipPathUnits' ],
		'mask'           => [ 'maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height' ],
		'use'            => [ 'href', 'x', 'y', 'width', 'height' ],
		// SMIL — see the class note. `attributeName` is separately restricted to SMIL_TARGETS.
		'animate'          => [ 'attributeName', 'attributeType', 'from', 'to', 'by', 'values', 'keyTimes', 'keySplines',
		                        'calcMode', 'dur', 'begin', 'end', 'repeatCount', 'repeatDur', 'restart',
		                        'additive', 'accumulate', 'min', 'max' ],
		'animateTransform' => [ 'attributeName', 'attributeType', 'type', 'from', 'to', 'by', 'values', 'keyTimes',
		                        'keySplines', 'calcMode', 'dur', 'begin', 'end', 'repeatCount', 'repeatDur', 'restart',
		                        'additive', 'accumulate', 'min', 'max' ],
		'set'              => [ 'attributeName', 'attributeType', 'to', 'dur', 'begin', 'end', 'repeatCount',
		                        'repeatDur', 'restart' ],
	];

	/**
	 * Attributes any allow-listed element may carry. Presentation and accessibility only.
	 *
	 * Deliberately ABSENT, and each for a reason: `filter` (there is no <filter> to point it at, see
	 * the class note), `href`/`xlink:href` except on <use> and the gradients, `externalResourcesRequired`,
	 * and every `on*` — which is rejected by name before the list is even consulted, so that an author
	 * gets "the event-handler attribute onload is never allowed" rather than a generic refusal.
	 */
	const GLOBAL_ATTRS = [
		'id', 'class', 'style',
		'transform', 'transform-origin', 'transform-box',
		'fill', 'fill-opacity', 'fill-rule',
		'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
		'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
		'vector-effect', 'paint-order',
		'opacity', 'color', 'display', 'visibility', 'mix-blend-mode', 'isolation',
		'shape-rendering', 'text-rendering', 'image-rendering', 'pointer-events',
		'clip-path', 'clip-rule', 'mask',
		'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
		'letter-spacing', 'word-spacing', 'text-anchor', 'dominant-baseline', 'baseline-shift', 'white-space',
		'role', 'aria-label', 'aria-labelledby', 'aria-hidden',
		'xml:space', 'xml:lang',
	];

	/**
	 * Named refusals — every one of these is ALREADY refused by the allow-list above. They are
	 * listed only so the member reads why, in one sentence, instead of "not on the allow-list".
	 */
	const REFUSED = [
		'script'        => 'it is executable code',
		'foreignObject' => 'it embeds arbitrary HTML inside the drawing',
		'iframe'        => 'it embeds another document',
		'image'         => 'it loads another file, which would fetch from a third party on every view',
		'audio'         => 'a drawing does not carry media',
		'video'         => 'a drawing does not carry media',
		'handler'       => 'it is an event handler',
		'a'             => 'a published drawing carries no links',
		'animateMotion' => 'its <mpath> can point at another document',
		'mpath'         => 'it points at another document',
		'filter'        => 'a filter chain can cost a reader unbounded GPU work on every view',
		'feImage'       => 'it loads another file',
		'font-face'     => 'it loads a font from another host',
		'font-face-uri' => 'it loads a font from another host',
		'metadata'      => 'RDF metadata can carry external references, and nothing renders it',
		'switch'        => 'it selects between alternatives we cannot all check',
	];

	/**
	 * The ONLY attributes SMIL may animate. Purely presentational and geometric: not one of them
	 * can hold a URL, a script or a class/style string, which is what makes SMIL safe here.
	 */
	const SMIL_TARGETS = [
		'opacity', 'fill', 'fill-opacity', 'fill-rule',
		'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset',
		'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
		'transform', 'transform-origin',
		'x', 'y', 'dx', 'dy', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2',
		'width', 'height', 'd', 'points', 'offset', 'rotate',
		'stop-color', 'stop-opacity', 'color', 'visibility', 'display',
		'font-size', 'letter-spacing', 'word-spacing', 'text-anchor',
		'gradientTransform', 'viewBox', 'vector-effect', 'mix-blend-mode', 'paint-order',
	];

	/** At-rules a scene may use. @import and @namespace are absent BY CONSTRUCTION — an at-rule that
	 *  is not on this list is refused, so external CSS is not merely blocked, it is unreachable. */
	const CSS_AT = [ 'keyframes', 'media', 'supports' ];

	/** Substrings that are never legitimate CSS in a drawing and are each a known execution vector. */
	const CSS_BANNED = [ 'expression(', 'javascript:', 'vbscript:', '-moz-binding', 'behavior:', 'image-set(', 'element(' ];

	// ── the entry point ───────────────────────────────────────────────────────

	/**
	 * Validate and REBUILD an SVG. Returns [ 'ok' => bool, 'svg' => string, 'why' => string ].
	 *
	 * On success 'svg' is OUR canonical serialisation — publish that, never the input. On failure
	 * 'svg' is '' and 'why' names the offending element or attribute in the member's own words.
	 *
	 * The rebuild runs TWICE and the two results must be identical. That is not paranoia about the
	 * parser: it is the contract Media::origin_servable() depends on, which will only put an SVG in
	 * the web root when the bytes it is given are byte-for-byte clean()'s own output. Without a
	 * proven fixed point that test could fail on a perfectly safe file and the whole feature would
	 * silently fall back to the CDN with nothing in any log.
	 */
	public static function clean( $svg ) {
		try {
			$once  = self::pass( (string) $svg );
			$twice = self::pass( $once );
			if ( $once !== $twice ) {
				self::bad( 'the drawing does not settle into a stable form when it is rebuilt, and we will not publish bytes we cannot reproduce' );
			}
			return [ 'ok' => true, 'svg' => $twice, 'why' => '' ];
		} catch ( \RuntimeException $e ) {
			return [ 'ok' => false, 'svg' => '', 'why' => $e->getMessage() ];
		} catch ( \Throwable $e ) {
			// Any unexpected failure is a REFUSAL, never a pass. Nothing reaches the web root on the
			// strength of an exception nobody predicted.
			return [ 'ok' => false, 'svg' => '', 'why' => 'the drawing could not be read (' . $e->getMessage() . ')' ];
		}
	}

	/** True when these bytes are already exactly what clean() would publish. */
	public static function is_clean( $svg ) {
		$c = self::clean( (string) $svg );
		return ! empty( $c['ok'] ) && hash_equals( (string) $c['svg'], (string) $svg );
	}

	// ── internals ─────────────────────────────────────────────────────────────

	/** Refuse, with the reason the member will read. */
	private static function bad( $why ) {
		throw new \RuntimeException( $why );
	}

	/** Shorten a value for a message without ever echoing a whole payload back at the author. */
	private static function snip( $s ) {
		$s = preg_replace( '/\s+/', ' ', (string) $s );
		return strlen( $s ) > 80 ? substr( $s, 0, 80 ) . '…' : $s;
	}

	/** One parse-and-rebuild. Throws on anything not allowed; returns the canonical document. */
	private static function pass( $svg ) {
		if ( ! class_exists( '\DOMDocument' ) ) {
			self::bad( 'this server has no XML parser, so no drawing can be checked or published' );
		}
		if ( '' === $svg ) { self::bad( 'the file is empty' ); }
		if ( strlen( $svg ) > self::MAX_BYTES ) {
			self::bad( 'the drawing is ' . size_format( strlen( $svg ) ) . '; the limit for an SVG is ' . size_format( self::MAX_BYTES ) );
		}
		if ( 0 === strncmp( $svg, "\xEF\xBB\xBF", 3 ) ) { $svg = substr( $svg, 3 ); }
		// preg with /u fails on invalid UTF-8, which is the cheapest correct test and needs no mbstring.
		if ( 1 !== preg_match( '//u', $svg ) ) { self::bad( 'the drawing is not valid UTF-8' ); }

		// BYTE-LEVEL REFUSALS, before libxml sees anything. Entity expansion is switched off below,
		// but a DTD has no business in a published drawing at all and refusing it outright is a
		// stronger statement than trusting one parser flag: no DOCTYPE, no internal subset, no
		// billion laughs, no XXE, and no xml-stylesheet instruction pulling in a remote stylesheet.
		// (Written without the literal instruction: a `?` followed by `>` inside a // comment ends
		// PHP mode, which is a fatal in a file that continues afterwards.)
		$probe = strtolower( $svg );
		foreach ( [
			'<!doctype'        => 'a DOCTYPE declaration',
			'<!entity'         => 'an ENTITY declaration',
			'<?xml-stylesheet' => 'an <?xml-stylesheet?> instruction',
		] as $needle => $label ) {
			if ( false !== strpos( $probe, $needle ) ) {
				self::bad( $label . ' is never allowed in a published drawing' );
			}
		}

		$prev = libxml_use_internal_errors( true );
		libxml_clear_errors();
		$doc = new \DOMDocument( '1.0', 'UTF-8' );
		$doc->preserveWhiteSpace = false;
		$doc->substituteEntities = false;   // never expand an entity — this is the billion-laughs pump
		$doc->resolveExternals   = false;   // never dereference an external entity — this is XXE
		$doc->validateOnParse    = false;
		// LIBXML_NOENT is DELIBERATELY absent: despite the name it ENABLES entity substitution.
		$loaded = $doc->loadXML( $svg, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING );
		$errs   = libxml_get_errors();
		libxml_clear_errors();
		libxml_use_internal_errors( $prev );

		if ( ! $loaded ) {
			$first = $errs ? trim( (string) $errs[0]->message ) : 'the parser gave no reason';
			self::bad( 'the drawing is not well-formed XML — ' . self::snip( $first ) );
		}
		if ( $doc->doctype ) { self::bad( 'a DOCTYPE declaration is never allowed in a published drawing' ); }
		$src = $doc->documentElement;
		if ( ! $src ) { self::bad( 'the drawing has no root element' ); }
		if ( 'svg' !== (string) $src->localName || self::NS !== (string) $src->namespaceURI ) {
			self::bad( 'the root element must be <svg> in the SVG namespace ' . self::NS
				. ' — this file\'s root is <' . (string) $src->nodeName . '>' );
		}

		$out = new \DOMDocument( '1.0', 'UTF-8' );
		$out->formatOutput = false;
		$state = [ 'els' => 0, 'css' => 0, 'uses' => [] ];
		$out->appendChild( self::copy( $src, $out, 1, $state ) );
		self::uses_bounded( $out, $state );
		$xml = $out->saveXML();
		if ( ! is_string( $xml ) || '' === trim( $xml ) ) { self::bad( 'the drawing could not be rebuilt' ); }
		return $xml;
	}

	/**
	 * Refuse a drawing whose <use> references can expand exponentially when rendered.
	 *
	 * Runs on the REBUILT document, so it sees exactly what we would publish. Two rules, and the
	 * second is the one that matters: a <use> may not resolve to a subtree that itself contains a
	 * <use>. That caps expansion at one level of indirection — a group reused N times costs N, and
	 * the 2^n construction becomes unconstructible rather than merely bounded by a number somebody
	 * would later raise. A dangling reference is also refused: it draws nothing, so it is either a
	 * mistake worth telling the author about or an attempt to smuggle an id past this check.
	 */
	private static function uses_bounded( $out, $state ) {
		$uses = $out->getElementsByTagNameNS( self::NS, 'use' );
		if ( $uses->length > self::MAX_USES ) {
			self::bad( 'the drawing reuses shapes ' . $uses->length . ' times; the limit is ' . self::MAX_USES );
		}
		$xp = new \DOMXPath( $out );
		$xp->registerNamespace( 's', self::NS );
		foreach ( $uses as $u ) {
			$id = ltrim( (string) $u->getAttribute( 'href' ), '#' );
			if ( '' === $id ) { continue; }
			$target = $xp->query( '//*[@id=' . self::xpath_literal( $id ) . ']' )->item( 0 );
			if ( ! $target ) {
				self::bad( 'the drawing reuses a shape called "' . self::snip( $id ) . '" that it never defines' );
			}
			if ( $target->getElementsByTagNameNS( self::NS, 'use' )->length > 0 ) {
				self::bad( 'the drawing reuses a shape that itself reuses another one; only one level is published, '
					. 'because chained reuse can multiply into millions of shapes from a few lines of source' );
			}
		}
	}

	/** Quote a string for XPath 1.0, which has no escape character — the reason this is not inline. */
	private static function xpath_literal( $s ) {
		if ( false === strpos( $s, "'" ) ) { return "'" . $s . "'"; }
		if ( false === strpos( $s, '"' ) ) { return '"' . $s . '"'; }
		return 'concat(' . implode( ",\"'\",", array_map( static function ( $p ) { return "'" . $p . "'"; },
			explode( "'", $s ) ) ) . ')';
	}

	/**
	 * Copy ONE element into the output document, recursively. Nothing is copied that is not named
	 * on the allow-list, so an element or attribute nobody has thought about fails closed here.
	 */
	private static function copy( $src, $out, $depth, &$state ) {
		if ( $depth > self::MAX_DEPTH ) {
			self::bad( 'the drawing nests elements more than ' . self::MAX_DEPTH . ' deep' );
		}
		$name = (string) $src->localName;
		if ( self::NS !== (string) $src->namespaceURI ) {
			self::bad( 'the element <' . (string) $src->nodeName . '> is not in the SVG namespace, and only SVG is published' );
		}
		if ( isset( self::REFUSED[ $name ] ) ) {
			self::bad( '<' . $name . '> is not allowed in a published drawing: ' . self::REFUSED[ $name ] );
		}
		if ( ! isset( self::ELEMENTS[ $name ] ) ) {
			self::bad( 'the element <' . $name . '> is not on the allow-list of what a published drawing may contain' );
		}
		$state['els']++;
		if ( $state['els'] > self::MAX_ELEMENTS ) {
			self::bad( 'the drawing has more than ' . self::MAX_ELEMENTS . ' elements' );
		}

		$el    = $out->createElementNS( self::NS, $name );
		$attrs = $src->attributes;
		$count = $attrs ? $attrs->length : 0;
		if ( $count > self::MAX_ATTRS ) {
			self::bad( '<' . $name . '> carries ' . $count . ' attributes; the limit is ' . self::MAX_ATTRS );
		}
		for ( $i = 0; $i < $count; $i++ ) {
			$a  = $attrs->item( $i );
			$ns = (string) $a->namespaceURI;
			$an = (string) $a->localName;
			$qn = (string) $a->nodeName;
			// Namespace declarations are not copied — the rebuild emits its own, and only its own.
			if ( self::NS_XMLNS === $ns || 'xmlns' === $qn || 0 === strpos( $qn, 'xmlns:' ) ) { continue; }
			// Named before the allow-list is consulted, so the reason is the real one.
			if ( preg_match( '/^on/i', $an ) ) {
				self::bad( 'the event-handler attribute ' . $qn . ' on <' . $name . '> is never allowed on a published drawing' );
			}
			$in_xml_ns = false;
			if ( '' !== $ns && self::NS !== $ns ) {
				if ( self::NS_XLINK === $ns && 'href' === $an ) {
					// Normalised to the plain SVG2 `href`, which every current browser honours and
					// which leaves exactly ONE attribute name for the same-document rule to police.
					// Skipped when the element already carries a plain href: browsers prefer that one,
					// so copying the xlink value over it would publish something they never render.
					if ( $src->hasAttribute( 'href' ) ) { continue; }
					$an = 'href';
				} elseif ( self::NS_XML === $ns && in_array( $an, [ 'space', 'lang' ], true ) ) {
					$in_xml_ns = true;
				} else {
					self::bad( 'the attribute ' . $qn . ' on <' . $name . '> is in a namespace we do not publish (' . $ns . ')' );
				}
			}
			$target = $in_xml_ns ? 'xml:' . $an : $an;
			if ( ! in_array( $target, self::GLOBAL_ATTRS, true )
				&& ! in_array( $target, self::ELEMENTS[ $name ], true ) ) {
				self::bad( 'the attribute ' . $target . ' on <' . $name . '> is not on the allow-list of what a published drawing may carry' );
			}
			$val = self::attr_value( $name, $target, (string) $a->value );
			if ( $in_xml_ns ) { $el->setAttributeNS( self::NS_XML, $target, $val ); }
			else { $el->setAttribute( $target, $val ); }
		}

		// <style> is the animation vehicle, and it is the ONE place raw text reaches the browser as
		// something other than characters. Its content is validated as CSS and emitted through a text
		// node, so the serialiser escapes it; css() additionally refuses '<' outright, which is the
		// only character that could ever close the element early under a different parser.
		if ( 'style' === $name ) {
			$css = self::css( (string) $src->textContent, $state );
			if ( '' !== $css ) { $el->appendChild( $out->createTextNode( $css ) ); }
			return $el;
		}

		foreach ( $src->childNodes as $kid ) {
			// DOMCdataSection extends DOMText, so it must be tested first. A CDATA section is copied
			// out as an ordinary text node, which is what removes it as a parsing trick.
			if ( $kid instanceof \DOMCdataSection ) { $el->appendChild( $out->createTextNode( self::text( $kid->data ) ) ); continue; }
			if ( $kid instanceof \DOMText )         { $el->appendChild( $out->createTextNode( self::text( $kid->data ) ) ); continue; }
			if ( $kid instanceof \DOMElement )      { $el->appendChild( self::copy( $kid, $out, $depth + 1, $state ) ); continue; }
			if ( $kid instanceof \DOMComment )      { continue; }   // dropped, never copied
			if ( $kid instanceof \DOMProcessingInstruction ) {
				self::bad( 'the processing instruction <?' . (string) $kid->target . '?> is not allowed in a published drawing' );
			}
			self::bad( 'the drawing contains a node we do not publish inside <' . $name . '>' );
		}
		return $el;
	}

	/** Text content: bounded, and free of the control characters that hide things from a reader. */
	private static function text( $s ) {
		$s = (string) $s;
		if ( strlen( $s ) > self::MAX_TEXT_BYTES ) {
			self::bad( 'a piece of text in the drawing is longer than ' . self::MAX_TEXT_BYTES . ' bytes' );
		}
		if ( preg_match( '/[\x00-\x08\x0B\x0C\x0E-\x1F]/', $s ) ) {
			self::bad( 'a piece of text in the drawing contains a control character' );
		}
		return $s;
	}

	/**
	 * Validate ONE attribute value and return it unchanged (href is trimmed, and that is the only
	 * rewrite anywhere in this class — see the idempotence contract on clean()).
	 *
	 * The value arrives ENTITY-DECODED from the parser. That is precisely why this class parses
	 * instead of scanning: `&#106;avascript:` is already `javascript:` by the time it gets here, and
	 * no amount of clever regex over the raw file would have seen it.
	 */
	private static function attr_value( $el, $attr, $val ) {
		$where = 'the attribute ' . $attr . ' on <' . $el . '>';
		if ( strlen( $val ) > self::MAX_ATTR_BYTES ) {
			self::bad( $where . ' is longer than ' . self::MAX_ATTR_BYTES . ' bytes' );
		}
		if ( preg_match( '/[\x00-\x08\x0B\x0C\x0E-\x1F]/', $val ) ) {
			self::bad( $where . ' contains a control character' );
		}
		// A backslash has no legitimate use in an SVG attribute and it is how a CSS escape smuggles a
		// token past a substring test — `\75 rl(` is `url(`. Refused everywhere, once.
		if ( false !== strpos( $val, '\\' ) ) {
			self::bad( $where . ' contains a backslash, which a drawing never needs and which can hide a CSS escape' );
		}
		// Whitespace and control characters removed before the scheme test, so `java\tscript:` is caught.
		$probe = strtolower( (string) preg_replace( '/[\s\x00-\x20]+/', '', $val ) );
		foreach ( [ 'javascript:', 'vbscript:', 'livescript:', 'mocha:' ] as $scheme ) {
			if ( false !== strpos( $probe, $scheme ) ) {
				self::bad( $where . ' contains "' . $scheme . '", which is executable code' );
			}
		}

		// A reference must be a bare same-document #fragment. This is the rule that stops the
		// tracking beacon: an https:// or data: href inside a feed card is a third-party request
		// fired on every impression, and img-src on this site allows https:.
		if ( 'href' === $attr ) {
			$t = trim( $val );
			if ( ! preg_match( '/^#[A-Za-z_][A-Za-z0-9_.:-]*$/', $t ) ) {
				self::bad( 'href="' . self::snip( $val ) . '" on <' . $el
					. '> points outside this file — a published drawing may only reference a #id inside itself, never another host' );
			}
			return $t;
		}
		self::urls_ok( $val, $where );

		if ( 'style' === $attr ) {
			if ( false !== strpos( $val, '@' ) ) { self::bad( $where . ' contains an at-rule, which an inline style may not' ); }
			if ( false !== strpos( $val, '<' ) ) { self::bad( $where . ' contains "<"' ); }
			$low = strtolower( $val );
			foreach ( self::CSS_BANNED as $tok ) {
				if ( false !== strpos( $low, $tok ) ) { self::bad( $where . ' contains "' . $tok . '", which is not allowed' ); }
			}
		}
		// SMIL: the whole safety of allowing animation rests on this one test. See the class note.
		if ( 'attributeName' === $attr && ! in_array( $val, self::SMIL_TARGETS, true ) ) {
			self::bad( '<' . $el . ' attributeName="' . self::snip( $val )
				. '"> animates an attribute we do not allow to be animated — a published drawing may only animate presentation and geometry, never a reference or a style string' );
		}
		if ( 'attributeType' === $attr && ! in_array( $val, [ 'XML', 'CSS', 'auto' ], true ) ) {
			self::bad( $where . ' must be XML, CSS or auto' );
		}
		if ( 'type' === $attr && 'animateTransform' === $el
			&& ! in_array( $val, [ 'translate', 'scale', 'rotate', 'skewX', 'skewY' ], true ) ) {
			self::bad( $where . ' must be translate, scale, rotate, skewX or skewY' );
		}
		if ( 'type' === $attr && 'style' === $el && 'text/css' !== strtolower( trim( $val ) ) ) {
			self::bad( $where . ' must be text/css' );
		}
		return $val;
	}

	/**
	 * Every url(...) in a value or a stylesheet must be a bare same-document #fragment.
	 *
	 * `fill="url(#grad)"` is how a gradient is used, so url() cannot simply be banned — but a url()
	 * naming a host is a request the reader's browser makes on our behalf, to somebody else, on
	 * every view. An unclosed url( is refused rather than ignored: a scanner that cannot see the end
	 * of a construct has not checked it.
	 */
	private static function urls_ok( $s, $where ) {
		$opens = preg_match_all( '/url\s*\(/i', (string) $s );
		if ( ! $opens ) { return; }
		$m = [];
		preg_match_all( '/url\s*\(\s*([^()]*?)\s*\)/i', (string) $s, $m );
		if ( count( $m[1] ) !== $opens ) {
			self::bad( 'a url(…) in ' . $where . ' could not be read to its closing bracket' );
		}
		foreach ( $m[1] as $ref ) {
			$ref = trim( trim( $ref ), "'\"" );
			if ( ! preg_match( '/^#[A-Za-z_][A-Za-z0-9_.:-]*$/', $ref ) ) {
				self::bad( 'url(' . self::snip( $ref ) . ') in ' . $where
					. ' points outside this file — a published drawing may only reference a #id inside itself. Anything else is fetched from another host on every single view.' );
			}
		}
	}

	/**
	 * Validate the CSS inside a <style> element, and return it unchanged.
	 *
	 * HOW IT IS BOUNDED, and why each bound is here:
	 *   · TOTAL SIZE across every <style> in the file (MAX_CSS_BYTES) — one budget, so twenty small
	 *     stylesheets cannot do what one large one may not.
	 *   · COMMENTS ARE REMOVED BEFORE ANY SCAN, so nothing hides inside one; an unterminated comment
	 *     is refused rather than silently swallowing the rest of the sheet.
	 *   · '<' IS REFUSED. It is the only character that could close the element early under a parser
	 *     that reads this file as something other than XML, and no stylesheet needs it.
	 *   · BACKSLASH IS REFUSED — a CSS escape is how `\75 rl(` becomes `url(` after every substring
	 *     test has already passed.
	 *   · AT-RULES ARE AN ALLOW-LIST (CSS_AT: @keyframes, @media, @supports, with a vendor prefix
	 *     tolerated). @import is therefore not "blocked", it is UNREACHABLE — and so is @font-face,
	 *     whose src: url() would fetch from another host. A vendor-prefixed unknown at-rule fails
	 *     closed like everything else. The scan is over the raw text, so an '@' inside a CSS string
	 *     (content: "@media") is refused too; that is a false refusal we accept, because failing
	 *     closed on a construct no generated scene needs is the cheap side of this trade.
	 *   · url() GOES THROUGH urls_ok — same-document #fragments only.
	 *   · A short list of known execution vectors (CSS_BANNED) is refused by name, so the member
	 *     reads which one they used.
	 */
	private static function css( $css, &$state ) {
		$css = trim( (string) $css );
		if ( '' === $css ) { return ''; }
		$state['css'] += strlen( $css );
		if ( $state['css'] > self::MAX_CSS_BYTES ) {
			self::bad( 'the drawing\'s <style> rules total more than ' . size_format( self::MAX_CSS_BYTES ) );
		}
		$scan = preg_replace( '#/\*.*?\*/#s', ' ', $css );
		if ( null === $scan ) { self::bad( 'the drawing\'s <style> rules could not be read' ); }
		if ( false !== strpos( $scan, '/*' ) ) {
			self::bad( 'the drawing\'s <style> rules contain an unterminated comment' );
		}
		if ( false !== strpos( $scan, '<' ) ) {
			self::bad( 'the drawing\'s <style> rules contain "<", which a stylesheet never needs and which can end the <style> element early' );
		}
		if ( false !== strpos( $scan, '\\' ) ) {
			self::bad( 'the drawing\'s <style> rules contain a backslash, which can hide a CSS escape such as \\75 rl( for url(' );
		}
		if ( preg_match( '/[\x00-\x08\x0B\x0C\x0E-\x1F]/', $scan ) ) {
			self::bad( 'the drawing\'s <style> rules contain a control character' );
		}
		$at = [];
		if ( preg_match_all( '/@(-[A-Za-z]+-)?([A-Za-z][A-Za-z-]*)/', $scan, $at, PREG_SET_ORDER ) ) {
			foreach ( $at as $hit ) {
				$rule = strtolower( $hit[2] );
				if ( ! in_array( $rule, self::CSS_AT, true ) ) {
					self::bad( 'the at-rule @' . $rule . ' is not allowed inside a published drawing — only @'
						. implode( ', @', self::CSS_AT ) . ' are' );
				}
			}
		}
		self::urls_ok( $scan, 'the drawing\'s <style> rules' );
		$low = strtolower( $scan );
		foreach ( self::CSS_BANNED as $tok ) {
			if ( false !== strpos( $low, $tok ) ) {
				self::bad( 'the drawing\'s <style> rules contain "' . $tok . '", which is not allowed' );
			}
		}
		return $css;
	}
}
