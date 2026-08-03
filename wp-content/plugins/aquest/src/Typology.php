<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The TYPOLOGY-SYSTEM REGISTRY — the entities behind the /topics hub (Big Five, MBTI, Enneagram, …),
 * each an authored, editable, sponsorable framework for understanding people. (Distinct from the
 * \AQ\Topics class, which is the course-subject HOUSE taxonomy — the 13 facet groups.)
 *
 * Migrated from the build-time artaquest-web/src/lib/typologies.data.json into the DB (operator
 * directive 2026-06-18) so topics become first-class like courses: every topic has an author (the
 * default creator, /u/arash) and is editable in Studio, and a company can SPONSOR a topic — its gift
 * is earmarked to the topic (Funds typ_<key> bucket) and shown as attribution, the industry-partner
 * funnel. The DB is the source of truth; data/topics.json is only the one-time seed (Schema::migrate →
 * seed_from_file, version-stamped). Served by GET /topics in the EXACT shape the SPA expects
 * (camelCase systems + the categories map), so the SPA simply fetches the API instead of the static
 * asset. High-volume read → public + CDN-cacheable; scalar columns + JSON blobs for options/
 * dimensions/citations (read whole, never queried into).
 */
final class Typology {

	const DEFAULT_AUTHOR_OPTION = 'aq_course_author_uid'; // shared default creator (/u/arash)
	const DEFAULT_AUTHOR_UID    = 138324856;

	/** The default author uid for a topic with no explicit owner (the platform creator, /u/arash). */
	public static function default_author() {
		$uid = (int) get_option( self::DEFAULT_AUTHOR_OPTION );
		return $uid > 0 ? $uid : self::DEFAULT_AUTHOR_UID;
	}

	/** Resolve a uid to a lightweight public author card {id,name,slug}; cached per request. */
	private static function author_card( $uid ) {
		static $cache = [];
		$uid = (int) $uid;
		if ( isset( $cache[ $uid ] ) ) { return $cache[ $uid ]; }
		$u = $uid ? get_userdata( $uid ) : null;
		return $cache[ $uid ] = $u
			? [ 'id' => $uid, 'name' => $u->display_name ?: $u->user_nicename, 'slug' => $u->user_nicename ]
			: [ 'id' => 0, 'name' => '', 'slug' => '' ];
	}

	/** Decode a stored JSON blob column to an array (null/'' → null so the key can be omitted). */
	private static function blob( $v ) {
		if ( $v === null || $v === '' ) { return null; }
		$d = json_decode( $v, true );
		return is_array( $d ) ? $d : null;
	}

	/** Shape one DB row into the SPA's system object (camelCase; only-present optional keys). */
	private static function shape( array $r ) {
		$sys = [
			'key'          => $r['topic_key'],
			'name'         => $r['name'],
			'category'     => $r['category'],
			'disciplines'  => Topics::parse_discs( (string) ( $r['disciplines'] ?? '' ) ),
			'status'       => $r['status'],
			'statusNote'   => (string) $r['status_note'],
			'blurb'        => (string) $r['blurb'],
			'format'       => $r['format'],
			'selfDescribe' => (bool) $r['self_describe'],
			'source'       => (string) $r['source'],
			'author'       => self::author_card( $r['author_id'] ),
		];
		foreach ( [ 'video' => 'video', 'instructor' => 'instructor', 'course' => 'course', 'image' => 'image' ] as $col => $k ) {
			if ( (string) $r[ $col ] !== '' ) { $sys[ $k ] = $r[ $col ]; }
		}
		$opt = self::blob( $r['options'] );        if ( $opt !== null ) { $sys['options'] = $opt; }
		$dim = self::blob( $r['dimensions'] );      if ( $dim !== null ) { $sys['dimensions'] = $dim; }
		$cit = self::blob( $r['citations'] );       if ( $cit !== null ) { $sys['citations'] = $cit; }
		if ( (string) $r['sponsor_name'] !== '' ) {
			$sys['sponsor'] = [
				'name' => $r['sponsor_name'],
				'url'  => (string) $r['sponsor_url'],
				'logo' => (string) $r['sponsor_logo'],
			];
		}
		// Signature: house (from the primary discipline) + the topic's own sign (HOW; stored, defaulting to
		// the primary discipline's, then the house's natural sign). WHY is no longer a content tag (operator
		// 2026-06-24) — it lives only as the 12 transiting cycles. See Topics::SIGNS.
		$cat   = (string) $r['category'];
		$house = Topics::disc_house( $cat ); if ( $house === '' ) { $house = Topics::DEFAULT_HOUSE; }
		$sys['house']  = $house;
		$sys['sign']   = ( isset( $r['sign'] ) && Topics::is_sign( (string) $r['sign'] ) ) ? (string) $r['sign'] : ( Topics::disc_sign( $cat ) ?: Topics::house_sign( $house ) );
		return $sys;
	}

	/**
	 * The whole registry in the SPA's shape: { version, categories, systems:[…] }. categories is the
	 * static category→group map stored at seed time. Public + cacheable; one indexed table scan.
	 */
	public static function all() {
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_topics' ) . " WHERE active = 1 ORDER BY name ASC", [] );
		$systems = array_map( [ __CLASS__, 'shape' ], (array) $rows );
		return [
			'version'    => (int) get_option( 'aq_topics_version', 1 ),
			'categories' => json_decode( (string) get_option( 'aq_topic_categories', '[]' ), true ) ?: [],
			'systems'    => $systems,
			'renames'    => self::renames_map(), // old-key → current-key aliases so the SPA self-corrects renamed URLs (#141)
		];
	}

	/**
	 * GET /sponsor/topics — the topics a donor can SPONSOR: active topics whose `course` link resolves to
	 * a LIVE published course (the only ones whose prize pool can actually receive the gift; the dangling
	 * links were cleared 2026-06-20). Light list — { items: [{ key, name, course }] }, name A→Z. Public +
	 * cacheable. Backs the Donate page's topic-sponsorship picker (Funds::sponsor_topic does the flow).
	 */
	public static function sponsorable() {
		$rows = Data::all(
			'SELECT t.topic_key, t.name, t.course FROM ' . Data::t( 'aq_topics' ) . ' t '
			. 'JOIN ' . Data::t( 'aq_courses' ) . " c ON c.slug = REPLACE( t.course, '/courses/', '' ) AND c.status = 'publish' "
			. "WHERE t.active = 1 AND t.course <> '' ORDER BY t.name ASC", []
		);
		return [ 'items' => array_map( fn( $r ) => [ 'key' => $r['topic_key'], 'name' => $r['name'], 'course' => $r['course'] ], (array) $rows ) ];
	}

	/** One system by key, or null. */
	public static function get( $key ) {
		$r = Data::one( 'SELECT * FROM ' . Data::t( 'aq_topics' ) . ' WHERE topic_key = %s AND active = 1', [ (string) $key ] );
		return $r ? self::shape( $r ) : null;
	}

	/** GET /topics/{key} handler — single system by key, 404 if unknown. A key that was RENAMED (#141)
	 *  resolves through the alias map to its current row, whose returned `key` is the new one — so a
	 *  client that requested an old key learns the canonical key and can update its URL. */
	public static function get_one( $req ) {
		$key = is_object( $req ) && method_exists( $req, 'get_param' ) ? (string) $req->get_param( 'key' ) : '';
		$t   = $key === '' ? null : self::get( $key );
		if ( ! $t && $key !== '' ) {
			$canon = self::canonical_key( $key );
			if ( $canon !== $key ) { $t = self::get( $canon ); }
		}
		return $t ?: new \WP_Error( 'not_found', 'Unknown topic', 404 );
	}

	/** Does the registry have any rows yet? (gate for the one-time seed) */
	public static function count() {
		return (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_topics' ), [] );
	}

	/**
	 * Plain create-or-update by key (NO request object) — the deterministic write path for tooling
	 * (ArtaCycle's topic phases, the type-ab backfill, migrations). $fields uses DB column names; the
	 * array columns options/dimensions/citations may be passed as PHP arrays (auto JSON-encoded). On an
	 * existing row only the supplied fields change — author_id + sponsor_* are PRESERVED unless given.
	 * Returns 'inserted' | 'updated'. Idempotent + non-destructive, so it is safe to re-run.
	 */
	public static function upsert( $key, array $fields, $author_id = null ) {
		global $wpdb;
		$key = sanitize_title( (string) $key );
		if ( $key === '' ) { return 'error'; }
		$T = Data::t( 'aq_topics' );
		$row = [];
		foreach ( $fields as $k => $v ) {
			if ( in_array( $k, [ 'options', 'dimensions', 'citations' ], true ) ) {
				$row[ $k ] = is_array( $v ) ? wp_json_encode( array_values( $v ) ) : ( is_string( $v ) ? $v : null );
			} elseif ( $k === 'self_describe' || $k === 'active' ) {
				$row[ $k ] = $v ? 1 : 0;
			} else {
				$row[ $k ] = is_scalar( $v ) ? (string) $v : '';
			}
		}
		$row['updated_ts'] = time();
		unset( $row['topic_key'], $row['id'], $row['created'] ); // never reassign identity here
		$id = (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $T WHERE topic_key = %s", $key ) );
		if ( $id ) {
			unset( $row['author_id'] ); // preserve existing authorship on update (pass explicitly to change)
			$wpdb->update( $T, $row, [ 'id' => $id ] );
			return 'updated';
		}
		$wpdb->insert( $T, $row + [ 'topic_key' => $key, 'author_id' => (int) ( $author_id ?: self::default_author() ), 'active' => 1, 'created' => time() ] );
		return 'inserted';
	}

	// ── editing (Studio): topics are first-class authored content; the operator can change ANYTHING ──
	const STATUSES = [ 'empirical', 'popular', 'traditional', 'cultural', 'demographic' ];
	const FORMATS  = [ 'single', 'multi', 'spectrum' ];

	/** Edit gate: operators always; otherwise the author at the Creator tier (matches can_edit_course). */
	public static function can_edit( $uid, $author_id ) {
		if ( user_can( $uid, 'manage_options' ) ) { return true; }
		$r = Extra::creator_rank( $uid );
		return (int) $uid > 0 && (int) $uid === (int) $author_id && ! empty( $r['caps']['can_create'] );
	}
	/** Create gate: operators or any Creator-tier member. */
	public static function can_create( $uid ) {
		if ( user_can( $uid, 'manage_options' ) ) { return true; }
		$r = Extra::creator_rank( $uid );
		return ! empty( $r['caps']['can_create'] );
	}

	/** Pull a writable column map from the request — ONLY the fields actually present (partial update). */
	private static function fields_from( $req, $for_create = false ) {
		$has = function ( $k ) use ( $req ) { return null !== $req->get_param( $k ); };
		$txt = function ( $k ) use ( $req ) { return sanitize_text_field( (string) $req->get_param( $k ) ); };
		$area = function ( $k ) use ( $req ) { return sanitize_textarea_field( (string) $req->get_param( $k ) ); };
		$f = [];
		if ( $has( 'name' ) )        { $f['name'] = $txt( 'name' ); }
		if ( $has( 'category' ) )    { $f['category'] = sanitize_key( str_replace( ' ', '-', strtolower( (string) $req->get_param( 'category' ) ) ) ); }
		if ( $has( 'disciplines' ) ) { // multi-membership: an array (or CSV) of discipline keys → comma-wrapped CSV
			$v = $req->get_param( 'disciplines' );
			$list = is_array( $v ) ? $v : explode( ',', (string) $v );
			$clean = Topics::parse_discs( implode( ',', array_map( 'strval', $list ) ) );
			$f['disciplines'] = $clean ? ',' . implode( ',', $clean ) . ',' : '';
		}
		if ( $has( 'sign' ) )        { $s = sanitize_key( (string) $req->get_param( 'sign' ) ); $f['sign'] = Topics::is_sign( $s ) ? $s : ''; }
		if ( $has( 'status' ) )      { $s = $txt( 'status' ); $f['status'] = in_array( $s, self::STATUSES, true ) ? $s : 'popular'; }
		if ( $has( 'statusNote' ) )  { $f['status_note'] = $area( 'statusNote' ); }
		if ( $has( 'blurb' ) )       { $f['blurb'] = $area( 'blurb' ); }
		if ( $has( 'format' ) )      { $fmt = $txt( 'format' ); $f['format'] = in_array( $fmt, self::FORMATS, true ) ? $fmt : 'single'; }
		if ( $has( 'selfDescribe' ) ) { $f['self_describe'] = $req->get_param( 'selfDescribe' ) ? 1 : 0; }
		if ( $has( 'source' ) )      { $f['source'] = $txt( 'source' ); }
		if ( $has( 'video' ) )       { $f['video'] = preg_replace( '/[^A-Za-z0-9_-]/', '', (string) $req->get_param( 'video' ) ); }
		if ( $has( 'instructor' ) )  { $f['instructor'] = $txt( 'instructor' ); }
		if ( $has( 'course' ) )      { $f['course'] = $txt( 'course' ); }
		if ( $has( 'image' ) )       { $f['image'] = $txt( 'image' ); } // URL or topic-art/<key>.svg path
		foreach ( [ 'options', 'dimensions', 'citations' ] as $blob ) {
			if ( $has( $blob ) ) {
				$v = $req->get_param( $blob );
				$f[ $blob ] = is_array( $v ) ? wp_json_encode( array_values( $v ) ) : null;
			}
		}
		if ( $has( 'sponsor_name' ) ) { $f['sponsor_name'] = $txt( 'sponsor_name' ); }
		if ( $has( 'sponsor_url' ) )  { $f['sponsor_url'] = esc_url_raw( (string) $req->get_param( 'sponsor_url' ) ); }
		if ( $has( 'sponsor_logo' ) ) { $f['sponsor_logo'] = esc_url_raw( (string) $req->get_param( 'sponsor_logo' ) ); }
		if ( $has( 'active' ) )       { $f['active'] = $req->get_param( 'active' ) ? 1 : 0; }
		$f['updated_ts'] = time();
		return $f;
	}

	/** POST /topics — create a new topic (operator or Creator). author_id = the creator. */
	public static function create( $req ) {
		$uid = get_current_user_id();
		if ( ! self::can_create( $uid ) ) { return Rest::err( 'forbidden', 'Reach the Creator tier (1,000 points) to author topics', 403 ); }
		$key = sanitize_title( (string) $req->get_param( 'key' ) );
		$name = sanitize_text_field( (string) $req->get_param( 'name' ) );
		if ( $key === '' || $name === '' ) { return Rest::err( 'bad_request', 'A key and a name are required', 400 ); }
		if ( self::get( $key ) || (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_topics' ) . ' WHERE topic_key = %s', [ $key ] ) ) {
			return Rest::err( 'conflict', "A topic with key '$key' already exists", 409 );
		}
		global $wpdb;
		$row = self::fields_from( $req, true ) + [
			'topic_key' => $key, 'name' => $name, 'author_id' => $uid, 'active' => 1, 'created' => time(),
		];
		if ( empty( $row['status'] ) ) { $row['status'] = 'popular'; }
		if ( empty( $row['format'] ) ) { $row['format'] = 'single'; }
		$wpdb->insert( Data::t( 'aq_topics' ), $row );
		return [ 'ok' => true, 'key' => $key ];
	}

	/** POST /topics/{key}/update — edit ANY field of a topic (author or operator). A `newKey` param
	 *  (different from the path key) RENAMES the topic's key/slug first (#141), cascading across every
	 *  reference and leaving a 301 redirect alias; the field update then applies to the same row. */
	public static function update( $req ) {
		$uid = get_current_user_id();
		$key = sanitize_title( (string) $req->get_param( 'key' ) );
		$r = Data::one( 'SELECT id, author_id FROM ' . Data::t( 'aq_topics' ) . ' WHERE topic_key = %s', [ $key ] );
		if ( ! $r ) { return Rest::err( 'not_found', 'Unknown topic', 404 ); }
		if ( ! self::can_edit( $uid, $r['author_id'] ) ) { return Rest::err( 'forbidden', 'Only the topic author can edit it', 403 ); }
		$renamed = false;
		$new_key = sanitize_title( (string) $req->get_param( 'newKey' ) );
		if ( $new_key !== '' && $new_key !== $key ) {
			if ( ! self::rename( $key, $new_key ) ) {
				return Rest::err( 'conflict', "Can't use the key '$new_key' — it's already taken by another topic", 409 );
			}
			$key = $new_key;
			$renamed = true;
		}
		$f = self::fields_from( $req );
		unset( $f['author_id'] ); // never reassign authorship via update
		global $wpdb;
		$wpdb->update( Data::t( 'aq_topics' ), $f, [ 'id' => (int) $r['id'] ] ); // same row id — bears the new key after a rename
		return [ 'ok' => true, 'key' => $key, 'renamed' => $renamed, 'updated' => array_keys( $f ) ];
	}

	// ── Key/slug rename (#141): keys are no longer immutable — a rename is a cascading cross-table +
	//    append-only-ledger migration plus a 301 redirect alias. Mirrors Topics::rename_discipline. ──

	/** Option holding the old-key → current-key alias map (JSON). Tiny + autoloaded: read on the hot
	 *  /topics registry route and the /topics/<key>/ redirect. Chains are collapsed on write. */
	const RENAMES_OPTION = 'aq_topic_renames';

	/** The old-key → current-key alias map (topics whose key changed after creation). */
	public static function renames_map() {
		$m = json_decode( (string) get_option( self::RENAMES_OPTION, '{}' ), true );
		return is_array( $m ) ? $m : [];
	}

	/** Resolve a (possibly renamed) topic key to its CURRENT canonical key — transitive + cycle-guarded.
	 *  An unknown / already-canonical key returns unchanged. Used by get_one + the theme 301 redirect. */
	public static function canonical_key( $key ) {
		$key  = sanitize_title( (string) $key );
		$map  = self::renames_map();
		$seen = [];
		while ( isset( $map[ $key ] ) && empty( $seen[ $key ] ) ) {
			$seen[ $key ] = true;
			$key = (string) $map[ $key ];
		}
		return $key;
	}

	/** Record an old→new alias so old /topics/<old>/ URLs 301 to the new key. Re-points any alias that
	 *  targeted $old at $new (collapsing chains) and never leaves the new key aliased to anything. */
	private static function record_rename( $old, $new ) {
		$map = self::renames_map();
		foreach ( $map as $k => $v ) { if ( (string) $v === $old ) { $map[ $k ] = $new; } }
		$map[ $old ] = $new;
		unset( $map[ $new ] ); // the new key is canonical now — it must never alias
		update_option( self::RENAMES_OPTION, wp_json_encode( $map ), true );
	}

	/**
	 * Rename a topic's KEY/slug after creation. The key is a cross-table identifier, so a rename moves
	 * EVERY reference at once:
	 *   • aq_topics.topic_key — the row's identity (UNIQUE; the new key must be free, any status)
	 *   • every member's public self-ID — aq_typology_selections (map keyed by system key) +
	 *     aq_typology_tags (each tag's systemKey)
	 *   • aq_endorsements.tag — the "<systemKey>:<key>" peer-endorsement rows
	 *   • the append-only typ_<key> sponsorship earmark — NEVER mutated: any HELD balance is TRANSFERRED
	 *     to typ_<new> by a zero-sum pair of ledger appends (Funds::rename_topic_earmark)
	 *   • a redirect alias (record_rename) so old URLs 301 to the new key
	 * Returns false when the old key is unknown or the new key is invalid / already taken. Idempotent on
	 * the no-op (old === new). Mirrors Topics::rename_discipline's cascade discipline.
	 */
	public static function rename( $old, $new ) {
		global $wpdb;
		$old = sanitize_title( (string) $old );
		$new = sanitize_title( (string) $new );
		if ( $old === '' || $new === '' || $old === $new ) { return false; }
		$T   = Data::t( 'aq_topics' );
		$row = Data::one( "SELECT id FROM $T WHERE topic_key = %s", [ $old ] );
		if ( ! $row ) { return false; }
		if ( Data::col( "SELECT 1 FROM $T WHERE topic_key = %s", [ $new ] ) ) { return false; } // taken (incl. soft-deleted)

		// 1) The topic row identity.
		$wpdb->update( $T, [ 'topic_key' => $new, 'updated_ts' => time() ], [ 'id' => (int) $row['id'] ] );
		// 2) Every member's self-ID (selections map + resolved public tags).
		self::rename_member_meta( $old, $new );
		// 3) Peer endorsements keyed "<systemKey>:<key>" — replace the system-key prefix (scoped by LIKE).
		$wpdb->query( $wpdb->prepare(
			'UPDATE ' . Data::t( 'aq_endorsements' ) . ' SET tag = REPLACE(tag, %s, %s) WHERE tag LIKE %s',
			$old . ':', $new . ':', $wpdb->esc_like( $old ) . ':%'
		) );
		// 4) Sponsorship earmark — append-only transfer of any held balance (never a row mutation).
		if ( class_exists( '\\AQ\\Funds' ) ) { Funds::rename_topic_earmark( $old, $new ); }
		// 5) Redirect alias so old /topics/<old>/ links keep resolving.
		self::record_rename( $old, $new );
		return true;
	}

	/** Migrate one renamed system key across every member's public self-ID usermeta: the selections map
	 *  (keyed by system key) and the resolved tag list (each tag's systemKey). LIKE-prefiltered on the
	 *  serialized value so only members who picked this system are touched, then verified after decode.
	 *  A rare operator/author action; the touched set is bounded by the system's popularity. */
	private static function rename_member_meta( $old, $new ) {
		global $wpdb;
		$needle = '%' . $wpdb->esc_like( '"' . $old . '"' ) . '%';

		// aq_typology_selections: { systemKey: {picks,levels,self} } — move the old key to the new key.
		foreach ( (array) $wpdb->get_results( $wpdb->prepare(
			"SELECT user_id, meta_value FROM {$wpdb->usermeta} WHERE meta_key = 'aq_typology_selections' AND meta_value LIKE %s", $needle
		) ) as $r ) {
			$sel = maybe_unserialize( $r->meta_value );
			if ( is_array( $sel ) && array_key_exists( $old, $sel ) ) {
				if ( ! array_key_exists( $new, $sel ) ) { $sel[ $new ] = $sel[ $old ]; }
				unset( $sel[ $old ] );
				update_user_meta( (int) $r->user_id, 'aq_typology_selections', $sel );
			}
		}
		// aq_typology_tags: [ { systemKey, key, … } ] — rewrite each tag's systemKey.
		foreach ( (array) $wpdb->get_results( $wpdb->prepare(
			"SELECT user_id, meta_value FROM {$wpdb->usermeta} WHERE meta_key = 'aq_typology_tags' AND meta_value LIKE %s", $needle
		) ) as $r ) {
			$tags = maybe_unserialize( $r->meta_value );
			if ( ! is_array( $tags ) ) { continue; }
			$changed = false;
			foreach ( $tags as &$t ) {
				if ( is_array( $t ) && isset( $t['systemKey'] ) && (string) $t['systemKey'] === $old ) { $t['systemKey'] = $new; $changed = true; }
			}
			unset( $t );
			if ( $changed ) { update_user_meta( (int) $r->user_id, 'aq_typology_tags', $tags ); }
		}
	}

	/** POST /topics/{key}/delete — soft-delete (active=0) so links/SEO degrade gracefully. */
	public static function delete( $req ) {
		$uid = get_current_user_id();
		$key = sanitize_title( (string) $req->get_param( 'key' ) );
		$r = Data::one( 'SELECT id, author_id FROM ' . Data::t( 'aq_topics' ) . ' WHERE topic_key = %s', [ $key ] );
		if ( ! $r ) { return Rest::err( 'not_found', 'Unknown topic', 404 ); }
		if ( ! self::can_edit( $uid, $r['author_id'] ) ) { return Rest::err( 'forbidden', 'Only the topic author can delete it', 403 ); }
		global $wpdb;
		$wpdb->update( Data::t( 'aq_topics' ), [ 'active' => 0, 'updated_ts' => time() ], [ 'id' => (int) $r['id'] ] );
		return [ 'ok' => true ];
	}

	/** GET /studio/topics — the editable list (operator: all; author: own). Lightweight cards. */
	public static function studio_list( $req ) {
		$uid = get_current_user_id();
		if ( ! self::can_create( $uid ) ) { return Rest::err( 'forbidden', 'Reach the Creator tier (1,000 points) to use the Studio', 403 ); }
		$op  = user_can( $uid, 'manage_options' );
		$rows = $op
			? Data::all( 'SELECT topic_key, name, category, status, author_id, sponsor_name, trend_score FROM ' . Data::t( 'aq_topics' ) . ' WHERE active = 1 ORDER BY name ASC', [] )
			: Data::all( 'SELECT topic_key, name, category, status, author_id, sponsor_name, trend_score FROM ' . Data::t( 'aq_topics' ) . ' WHERE active = 1 AND author_id = %d ORDER BY name ASC', [ $uid ] );
		$items = array_map( function ( $r ) {
			return [ 'key' => $r['topic_key'], 'name' => $r['name'], 'category' => $r['category'], 'status' => $r['status'], 'sponsor' => (string) $r['sponsor_name'], 'trend' => (int) $r['trend_score'] ];
		}, (array) $rows );
		return [ 'items' => $items, 'total' => count( $items ), 'can_create' => true ];
	}

	/** GET /studio/topics/{key} — the FULL raw topic for editing (every field, decoded). */
	public static function studio_get( $req ) {
		$uid = get_current_user_id();
		$key = sanitize_title( (string) $req->get_param( 'key' ) );
		$r = Data::one( 'SELECT * FROM ' . Data::t( 'aq_topics' ) . ' WHERE topic_key = %s', [ $key ] );
		if ( ! $r ) { return Rest::err( 'not_found', 'Unknown topic', 404 ); }
		if ( ! self::can_edit( $uid, $r['author_id'] ) ) { return Rest::err( 'forbidden', 'Only the topic author can edit it', 403 ); }
		$house = Topics::disc_house( (string) $r['category'] ); if ( $house === '' ) { $house = Topics::DEFAULT_HOUSE; }
		return [
			'key' => $r['topic_key'], 'name' => $r['name'], 'category' => $r['category'], 'status' => $r['status'],
			'trend' => (int) ( $r['trend_score'] ?? -1 ),
			'statusNote' => (string) $r['status_note'], 'blurb' => (string) $r['blurb'], 'format' => $r['format'],
			'selfDescribe' => (bool) $r['self_describe'], 'source' => (string) $r['source'], 'video' => (string) $r['video'],
			'instructor' => (string) $r['instructor'], 'course' => (string) $r['course'], 'image' => (string) $r['image'],
			'options' => self::blob( $r['options'] ) ?: [], 'dimensions' => self::blob( $r['dimensions'] ) ?: [],
			'citations' => self::blob( $r['citations'] ) ?: [],
			// effective sign (HOW; stored value, else inherited from the primary discipline / house)
			'sign'   => Topics::is_sign( (string) ( $r['sign'] ?? '' ) )   ? (string) $r['sign']   : ( Topics::disc_sign( (string) $r['category'] )   ?: Topics::house_sign( $house ) ),
			'sponsor_name' => (string) $r['sponsor_name'], 'sponsor_url' => (string) $r['sponsor_url'], 'sponsor_logo' => (string) $r['sponsor_logo'],
			'author' => self::author_card( $r['author_id'] ),
		];
	}

	/**
	 * ONE-TIME seed from data/topics.json (the migrated typologies.data.json). Upsert by key: a NEW key
	 * is inserted under the default author; an EXISTING key has only its base definition refreshed and
	 * KEEPS its author_id + sponsor (so a re-seed never clobbers a Studio edit / sponsorship / ArtaCycle
	 * DB write). Returns [inserted, updated]. Dependency-free; safe to re-run.
	 */
	public static function seed_from_file( $path = null ) {
		global $wpdb;
		$path = $path ?: ( defined( 'AQ_DIR' ) ? AQ_DIR . '/data/topics.json' : __DIR__ . '/../data/topics.json' );
		if ( ! is_readable( $path ) ) { return [ 'error' => "seed file not readable: $path" ]; }
		$data = json_decode( (string) file_get_contents( $path ), true );
		if ( ! is_array( $data ) || empty( $data['systems'] ) ) { return [ 'error' => 'seed file malformed' ]; }

		// Static category→group map travels with the registry (the SPA needs it to build the facet tree).
		if ( isset( $data['categories'] ) ) { update_option( 'aq_topic_categories', wp_json_encode( $data['categories'] ), false ); }
		if ( isset( $data['version'] ) )    { update_option( 'aq_topics_version', (int) $data['version'], false ); }

		$T   = Data::t( 'aq_topics' );
		$def = self::default_author();
		$now = time();
		$ins = 0; $upd = 0;
		foreach ( $data['systems'] as $s ) {
			$key = isset( $s['key'] ) ? (string) $s['key'] : '';
			if ( $key === '' ) { continue; }
			$base = [
				'name'         => (string) ( $s['name'] ?? '' ),
				'category'     => (string) ( $s['category'] ?? '' ),
				'status'       => (string) ( $s['status'] ?? '' ),
				'status_note'  => (string) ( $s['statusNote'] ?? '' ),
				'blurb'        => (string) ( $s['blurb'] ?? '' ),
				'format'       => (string) ( $s['format'] ?? '' ),
				'self_describe' => ! empty( $s['selfDescribe'] ) ? 1 : 0,
				'source'       => (string) ( $s['source'] ?? '' ),
				'video'        => (string) ( $s['video'] ?? '' ),
				'instructor'   => (string) ( $s['instructor'] ?? '' ),
				'course'       => (string) ( $s['course'] ?? '' ),
				'image'        => (string) ( $s['image'] ?? '' ),
				'options'      => isset( $s['options'] ) ? wp_json_encode( $s['options'] ) : null,
				'dimensions'   => isset( $s['dimensions'] ) ? wp_json_encode( $s['dimensions'] ) : null,
				'citations'    => isset( $s['citations'] ) ? wp_json_encode( $s['citations'] ) : null,
				'updated_ts'   => $now,
			];
			$id = (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $T WHERE topic_key = %s", $key ) );
			if ( $id ) {
				$wpdb->update( $T, $base, [ 'id' => $id ] ); // preserve author_id + sponsor_* (not in $base)
				$upd++;
			} else {
				$wpdb->insert( $T, $base + [ 'topic_key' => $key, 'author_id' => $def, 'active' => 1, 'created' => $now ] );
				$ins++;
			}
		}
		return [ 'inserted' => $ins, 'updated' => $upd, 'total' => count( $data['systems'] ) ];
	}

	/**
	 * ADD-ONLY importer for NEW topics that ship with a deploy — data/topics-add.json (the same
	 * { "systems":[…] } SPA shape as the seed). This is how a member-requested topic reaches POPULATED
	 * prod: seed_from_file is the one-time migration seed (gated on an empty table), so a topic added
	 * after the 2026-06-18 DB cutover would otherwise never land. Mirrors Extra::import_courses /
	 * Topics::import_disc_file — filemtime-gated, dependency-free, non-destructive:
	 *   • a key ALREADY present (active OR soft-deleted) is SKIPPED, so an operator delete, a Studio
	 *     edit, an ArtaCycle write, or a prior import is never clobbered or resurrected;
	 *   • a NEW key is INSERTed via upsert() under the default author.
	 * Re-imports only when the file's mtime changes. Returns [inserted, skipped] for callers/tests.
	 */
	public static function import_added() {
		global $wpdb;
		$file = ( defined( 'AQ_DIR' ) ? AQ_DIR : __DIR__ . '/..' ) . '/data/topics-add.json';
		if ( ! is_readable( $file ) ) { return [ 'inserted' => 0, 'skipped' => 0 ]; }
		$mtime = (string) filemtime( $file );
		if ( get_option( 'aq_topics_add_mtime' ) === $mtime ) { return [ 'inserted' => 0, 'skipped' => 0 ]; }
		$data    = json_decode( (string) file_get_contents( $file ), true );
		$systems = is_array( $data ) ? ( $data['systems'] ?? [] ) : [];
		$T = Data::t( 'aq_topics' );
		$ins = 0; $skip = 0;
		foreach ( (array) $systems as $s ) {
			$key = isset( $s['key'] ) ? sanitize_title( (string) $s['key'] ) : '';
			if ( $key === '' ) { continue; }
			// ADD-ONLY: any existing row wins (active OR soft-deleted) — never clobber/resurrect.
			if ( (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM $T WHERE topic_key = %s", $key ) ) ) { $skip++; continue; }
			// disciplines: array of keys → the comma-wrapped CSV the column stores (read by Topics::parse_discs).
			$discs = '';
			if ( ! empty( $s['disciplines'] ) && is_array( $s['disciplines'] ) ) {
				$clean = [];
				foreach ( $s['disciplines'] as $d ) { $d = sanitize_key( (string) $d ); if ( $d !== '' && ! in_array( $d, $clean, true ) ) { $clean[] = $d; } }
				if ( $clean ) { $discs = ',' . implode( ',', $clean ) . ','; }
			}
			self::upsert( $key, [
				'name'          => (string) ( $s['name'] ?? '' ),
				'category'      => (string) ( $s['category'] ?? '' ),
				'disciplines'   => $discs,
				'status'        => (string) ( $s['status'] ?? 'cultural' ),
				'status_note'   => (string) ( $s['statusNote'] ?? '' ),
				'blurb'         => (string) ( $s['blurb'] ?? '' ),
				'format'        => (string) ( $s['format'] ?? 'single' ),
				'self_describe' => ! empty( $s['selfDescribe'] ) ? 1 : 0,
				'source'        => (string) ( $s['source'] ?? '' ),
				'video'         => (string) ( $s['video'] ?? '' ),
				'instructor'    => (string) ( $s['instructor'] ?? '' ),
				'course'        => (string) ( $s['course'] ?? '' ),
				'image'         => (string) ( $s['image'] ?? '' ),
				'options'       => $s['options'] ?? null,
				'dimensions'    => $s['dimensions'] ?? null,
				'citations'     => $s['citations'] ?? null,
			] );
			$ins++;
		}
		update_option( 'aq_topics_add_mtime', $mtime, false );
		return [ 'inserted' => $ins, 'skipped' => $skip ];
	}

	/**
	 * Deploy-carried IMAGE REFRESH for topics ALREADY on prod — data/topics-image-sync.json
	 * ({ "systems":[ { "key", "image", "optionImages": { "<optKey>": "<path>", … } } ] }).
	 * import_added() is strictly ADD-ONLY (an existing key is skipped), so it can NOT fix the pictures
	 * of a topic that was already imported — which is exactly the case for a topic whose art is improved
	 * after the fact (the South Park characters, #146: faceless Wikimedia hat SVGs → self-hosted
	 * recognizable portraits in public/topic-art/). This narrowly updates ONLY image fields:
	 *   • the system card `image` column, and
	 *   • each option's `image`, MERGED into the existing options blob BY OPTION KEY — so labels,
	 *     descriptions and any other authored/Studio-edited field are preserved (we touch only `image`).
	 * Filemtime-gated, dependency-free, idempotent (writes only when a value actually changes) and
	 * non-destructive to every non-image field. An unknown key is skipped (new topics come via
	 * import_added). Mirrors the import_added / Extra::import_courses provisioning pattern.
	 */
	public static function import_image_updates() {
		$file = ( defined( 'AQ_DIR' ) ? AQ_DIR : __DIR__ . '/..' ) . '/data/topics-image-sync.json';
		if ( ! is_readable( $file ) ) { return [ 'updated' => 0, 'skipped' => 0 ]; }
		$mtime = (string) filemtime( $file );
		if ( get_option( 'aq_topics_image_sync_mtime' ) === $mtime ) { return [ 'updated' => 0, 'skipped' => 0 ]; }
		$data    = json_decode( (string) file_get_contents( $file ), true );
		$systems = is_array( $data ) ? ( $data['systems'] ?? [] ) : [];
		$T = Data::t( 'aq_topics' );
		$upd = 0; $skip = 0;
		foreach ( (array) $systems as $s ) {
			$key = isset( $s['key'] ) ? sanitize_title( (string) $s['key'] ) : '';
			if ( $key === '' ) { continue; }
			// Update-images path: touch ONLY a row that already exists (a new topic lands via import_added).
			$row = Data::one( "SELECT id, image, options FROM $T WHERE topic_key = %s", [ $key ] );
			if ( ! $row ) { $skip++; continue; }
			$fields = [];
			// System card image — set only when it actually changes (idempotent; no needless write).
			$sys_img = isset( $s['image'] ) ? (string) $s['image'] : '';
			if ( $sys_img !== '' && $sys_img !== (string) $row['image'] ) { $fields['image'] = $sys_img; }
			// Per-option images — merge into the existing options blob by key (preserve label/desc/etc.).
			$opt_imgs = ( isset( $s['optionImages'] ) && is_array( $s['optionImages'] ) ) ? $s['optionImages'] : [];
			if ( $opt_imgs ) {
				$opts = self::blob( $row['options'] );
				if ( is_array( $opts ) ) {
					$changed = false;
					foreach ( $opts as &$o ) {
						if ( is_array( $o ) && isset( $o['key'], $opt_imgs[ $o['key'] ] ) ) {
							$new = (string) $opt_imgs[ $o['key'] ];
							if ( $new !== '' && ( ! isset( $o['image'] ) || (string) $o['image'] !== $new ) ) {
								$o['image'] = $new;
								$changed = true;
							}
						}
					}
					unset( $o );
					if ( $changed ) { $fields['options'] = $opts; } // upsert() JSON-encodes an array blob
				}
			}
			if ( $fields ) { self::upsert( $key, $fields ); $upd++; } else { $skip++; }
		}
		update_option( 'aq_topics_image_sync_mtime', $mtime, false );
		return [ 'updated' => $upd, 'skipped' => $skip ];
	}
}
