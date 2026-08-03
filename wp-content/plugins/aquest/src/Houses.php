<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Operator "Houses" Studio mode — control the per-house sidereal-analysis FIELDS.
 *
 * The sidereal trend-fit (the 15-parameter model: numpy/scipy/scikit-learn over Google-Trends series) runs in the
 * OFFLINE Python pipeline, NOT on prod. So add/delete are QUEUED here (option `aq_fields_queue`) and the offline
 * collector drains the queue (`Houses::drain()` over wp-cli), collects the new field / purges the deleted one, and
 * redeploys the regenerated atlas. Studio shows the live atlas (the analysed fields) plus the pending queue, so the
 * operator always sees what is in flight.
 */
class Houses {
	const QUEUE = 'aq_fields_queue';

	private static function gate() { return current_user_can( 'manage_options' ); }

	/** The pending work-list: { add: [search words to analyse], remove: [field keys to purge] }. */
	private static function queue() {
		$q = json_decode( (string) get_option( self::QUEUE, '' ), true );
		if ( ! is_array( $q ) ) { $q = array(); }
		return array(
			'add'    => array_values( array_unique( array_filter( array_map( 'strval', (array) ( $q['add'] ?? array() ) ) ) ) ),
			'remove' => array_values( array_unique( array_filter( array_map( 'strval', (array) ( $q['remove'] ?? array() ) ) ) ) ),
		);
	}
	private static function save_queue( $q ) { update_option( self::QUEUE, wp_json_encode( $q ), false ); }

	/** GET studio/houses — the 12 houses, each with its analysed fields (from the disciplines registry), split by
	 *  camp (noun = What / adj = How) with the rep-eligible flag + decisiveness ratio; plus the pending queue. */
	public static function list_rest( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$by = array();
		foreach ( Topics::disciplines() as $d ) {
			$h = (string) ( $d['house'] ?? '' );
			if ( ! Topics::is_valid( $h ) ) { continue; }
			$by[ $h ][] = array(
				'key'   => (string) ( $d['key'] ?? '' ),
				'label' => (string) ( $d['label'] ?? '' ),
				'pos'   => ( (string) ( $d['pos'] ?? 'noun' ) === 'adj' ) ? 'adj' : 'noun',
				'score' => (int) ( $d['score'] ?? 0 ),
				'ratio' => round( (float) ( $d['ratio'] ?? 0 ), 3 ),  // max/2nd-max sign area
				'rep'   => (int) ( $d['central'] ?? 0 ),              // rep-eligible: ratio > 1.5
			);
		}
		$houses = array();
		foreach ( array_keys( Topics::ALL ) as $key ) {
			$fields = $by[ $key ] ?? array();
			usort( $fields, function ( $a, $b ) { return $b['score'] <=> $a['score']; } );
			$houses[] = array(
				'key'    => $key,
				'label'  => Topics::house_label( $key ),               // the frontend maps the house key → its zodiac sign
				'fields' => $fields,
			);
		}
		return array( 'houses' => $houses, 'queue' => self::queue() );
	}

	/** POST studio/houses/field — operator queues an ADD (a new search WORD to analyse) or a REMOVE (a field KEY to
	 *  purge). The offline collector applies it on its next pass and redeploys; nothing is analysed on prod. */
	public static function field_rest( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$action = sanitize_key( (string) Rest::p( $req, 'action', '' ) );
		$value  = sanitize_text_field( (string) Rest::p( $req, 'value', '' ) );
		$value  = trim( preg_replace( '/\s+/', ' ', strtolower( $value ) ) );
		if ( $value === '' || mb_strlen( $value ) < 2 || mb_strlen( $value ) > 60 ) {
			return Rest::err( 'bad_input', 'A field word/key is required (2–60 characters)' );
		}
		if ( ! in_array( $action, array( 'add', 'remove' ), true ) ) {
			return Rest::err( 'bad_input', 'action must be "add" or "remove"' );
		}
		$q = self::queue();
		$q[ $action === 'add' ? 'add' : 'remove' ][] = $value;
		self::save_queue( $q );
		return array( 'ok' => true, 'queue' => self::queue() );
	}

	/** POST studio/houses/unqueue — operator removes a still-pending item from the queue (a typo, a change of mind). */
	public static function unqueue_rest( $req ) {
		if ( ! self::gate() ) { return Rest::err( 'forbidden', 'Operators only', 403 ); }
		$action = sanitize_key( (string) Rest::p( $req, 'action', '' ) );
		$value  = trim( strtolower( (string) Rest::p( $req, 'value', '' ) ) );
		$q = self::queue();
		$bucket = $action === 'add' ? 'add' : 'remove';
		$q[ $bucket ] = array_values( array_filter( $q[ $bucket ], function ( $v ) use ( $value ) { return $v !== $value; } ) );
		self::save_queue( $q );
		return array( 'ok' => true, 'queue' => self::queue() );
	}

	/** Drain + clear the queue. Called by the OFFLINE collector over wp-cli (`wp eval`), which then applies each
	 *  add/remove to the analysis registries and redeploys. Returns the drained { add, remove }. */
	public static function drain() {
		$q = self::queue();
		self::save_queue( array( 'add' => array(), 'remove' => array() ) );
		return $q;
	}
}
