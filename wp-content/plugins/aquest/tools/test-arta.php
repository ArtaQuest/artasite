<?php
/**
 * test-arta.php — @arta, the public assistant, exercised without WordPress.
 *
 *   php wp-content/plugins/aquest/tools/test-arta.php        # exit 0 = green
 *
 * Part 1 (pure): mention detection, reserved handles, the bug prefix, the rate-limit verdict, reply sanitising/clipping, and the ACS e-mail signature.
 *
 * Part 2 (database): the real Arta + Data classes over an in-memory SQLite database standing in for
 * $wpdb — the same SQL production runs. It proves: a source is queued ONCE however often it is
 * recorded; Arta never answers itself; the per-member hourly limit turns the (USER_PER_HOUR+1)th mention into a
 * 'limited' row and a private notice; a claim is exclusive (the second caller gets 409); a reply is
 * written exactly once (a retry returns duplicate:true and writes nothing); a status change cannot
 * undo a reply; nothing is pushed anywhere (the brain pulls, and its poll is its heartbeat); and
 * housekeeping frees dead claims and expires old mentions. Needs pdo_sqlite + mbstring; without them Part 2 prints SKIP (never a pass) and exits 2.
 */

namespace {
	define( 'ABSPATH', __DIR__ . '/' );
	define( 'ARRAY_A', 'ARRAY_A' );
	$GLOBALS['T_OPTS'] = []; $GLOBALS['T_NOTIFY'] = []; $GLOBALS['T_HTTP'] = []; $GLOBALS['T_SECRETS'] = [];
	$GLOBALS['T_USERS'] = [];
	function get_option( $k, $d = false ) { return array_key_exists( $k, $GLOBALS['T_OPTS'] ) ? $GLOBALS['T_OPTS'][ $k ] : $d; }
	function update_option( $k, $v, $a = null ) { $GLOBALS['T_OPTS'][ $k ] = $v; return true; }
	function get_userdata( $id ) { return $GLOBALS['T_USERS'][ (int) $id ] ?? false; }
	function get_user_by( $f, $v ) { foreach ( $GLOBALS['T_USERS'] as $u ) { if ( ( $f === 'slug' && $u->user_nicename === $v ) || ( $f === 'login' && $u->user_login === $v ) ) { return $u; } } return false; }
	function get_user_meta( $id, $k, $s = false ) { return $GLOBALS['T_USERS'][ (int) $id ]->meta[ $k ] ?? ''; }
	function home_url( $p = '' ) { return 'https://artaquest.com' . $p; }
	function wp_json_encode( $v ) { return json_encode( $v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ); }
	function wp_remote_post( $url, $args ) { $GLOBALS['T_HTTP'][] = [ $url, $args ]; return [ 'response' => [ 'code' => 202 ] ]; }
	function wp_strip_all_tags( $s ) { return trim( strip_tags( (string) $s ) ); }
	function sanitize_text_field( $s ) { return trim( preg_replace( '/[\r\n\t ]+/', ' ', strip_tags( (string) $s ) ) ); }
	function esc_url_raw( $u ) { return filter_var( $u, FILTER_VALIDATE_URL ) ? (string) $u : ''; }
	function wp_make_link_relative( $u ) { return preg_replace( '#^https?://[^/]+#', '', (string) $u ); }
	function wp_trim_words( $t, $n = 55, $more = '…' ) { $w = preg_split( '/\s+/', trim( (string) $t ) ); return count( $w ) > $n ? implode( ' ', array_slice( $w, 0, $n ) ) . $more : implode( ' ', $w ); }
	function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
	function is_email( $e ) { return (bool) filter_var( $e, FILTER_VALIDATE_EMAIL ); }

	/** $wpdb over SQLite: just the calls Data and Arta make. MySQL-only syntax is translated. */
	final class T_Wpdb {
		public $prefix = 'wp_'; public $insert_id = 0; private $pdo;
		public function __construct( $pdo ) { $this->pdo = $pdo; }
		public function prepare( $sql, ...$args ) {
			if ( count( $args ) === 1 && is_array( $args[0] ) ) { $args = $args[0]; }
			$i = 0; $pdo = $this->pdo;
			return preg_replace_callback( '/%[ds]/', function ( $m ) use ( &$i, $args, $pdo ) {
				$v = $args[ $i++ ] ?? null;
				return $m[0] === '%d' ? (string) (int) $v : $pdo->quote( (string) $v );
			}, $sql );
		}
		private function fix( $sql ) { return preg_replace( '/^\s*INSERT IGNORE/i', 'INSERT OR IGNORE', $sql ); }
		public function query( $sql ) { $n = $this->pdo->exec( $this->fix( $sql ) ); return $n === false ? false : $n; }
		public function get_row( $sql, $o = null ) { $r = $this->pdo->query( $sql )->fetch( \PDO::FETCH_ASSOC ); return $r ?: null; }
		public function get_results( $sql, $o = null ) { return $this->pdo->query( $sql )->fetchAll( \PDO::FETCH_ASSOC ); }
		public function get_var( $sql ) { $r = $this->pdo->query( $sql )->fetch( \PDO::FETCH_NUM ); return $r ? $r[0] : null; }
		public function insert( $t, $d ) {
			$st = $this->pdo->prepare( "INSERT INTO $t (" . implode( ',', array_keys( $d ) ) . ') VALUES (' . implode( ',', array_fill( 0, count( $d ), '?' ) ) . ')' );
			$ok = $st->execute( array_values( $d ) ); $this->insert_id = (int) $this->pdo->lastInsertId(); return $ok ? 1 : false;
		}
		public function update( $t, $d, $w ) {
			$set = implode( ',', array_map( fn( $k ) => "$k = ?", array_keys( $d ) ) );
			$wh  = implode( ' AND ', array_map( fn( $k ) => "$k = ?", array_keys( $w ) ) );
			$st  = $this->pdo->prepare( "UPDATE $t SET $set WHERE $wh" ); $st->execute( array_merge( array_values( $d ), array_values( $w ) ) );
			return $st->rowCount();
		}
		public function suppress_errors( $s = true ) { return false; }
	}
}

namespace AQ {
	// Collaborators Arta calls, reduced to what the assertions need to observe.
	final class Secrets { public static function get( $k ) { return (string) ( $GLOBALS['T_SECRETS'][ $k ] ?? '' ); } }
	final class Media {
		public static $stored = [];
		public static function url( $k ) { return 'https://cdn.test/' . ltrim( (string) $k, '/' ); }
		public static function put_public_file( $k, $path, $mime ) { self::$stored[ $k ] = [ $mime, filesize( $path ) ]; return true; }
	}
	final class Notify { public static function push( $uid, $type, $title, $body = '', $url = '', $key = '' ) { $GLOBALS['T_NOTIFY'][] = compact( 'uid', 'type', 'title', 'body', 'url', 'key' ); } }
	final class Tickets { public static $opened = []; public static function open_from_arta( ...$a ) { self::$opened[] = $a; return 1; } }
	final class Rest {
		public static function p( $req, $k, $d = null ) { return $req[ $k ] ?? $d; }
		public static function pint( $req, $k, $d = 0 ) { return (int) ( $req[ $k ] ?? $d ); }
		public static function err( $code, $msg, $status = 400 ) { return [ 'error' => $code, 'message' => $msg, 'status' => $status ]; }
		public static $uid = 0;
		public static function uid() { return self::$uid; }
	}
	final class Notebook {
		public static function post_url( $id ) { return '/works/?post=' . (int) $id; }
		public static function insert_reply( $uid, $parent, $body ) {
			$id = Data::insert( 'aq_posts', [ 'author_id' => $uid, 'body' => $body, 'parent_id' => $parent, 'created' => time() ] );
			Data::bump( 'aq_posts', [ 'id' => $parent ], 'reply_count' );
			return $id;
		}
	}
}

namespace {
	use AQ\Arta;

	$fails = 0; $passes = 0;
	function t_ok( $cond, $label ) { global $fails, $passes; if ( $cond ) { $passes++; echo "PASS  $label\n"; } else { $fails++; echo "FAIL  $label\n"; } }

	$src = dirname( __DIR__ ) . '/src/';
	$have_mb = function_exists( 'mb_substr' );
	if ( ! $have_mb ) { echo "SKIP  everything — mbstring is not installed (production and CI have it)\n"; exit( 2 ); }
	require $src . 'Arta.php';
	require $src . 'Data.php';

	// ── Part 1: pure helpers ──────────────────────────────────────────────────────────────────
	$cases = [
		[ 'Hey @Arta what is a p-value?', [ 'arta' ] ],
		[ '@arta, @ArtaBot and @someone-else', [ 'arta', 'artabot', 'someone-else' ] ],
		[ 'mail me@arta.org or see x.com/@arta', [] ],
		[ '@ab is too short, @-bad- is not a handle', [] ],
		[ '(@arta) "@arta" @arta. @arta!', [ 'arta' ] ],
		[ '@arta.com is a domain, not a mention', [] ],
		[ '@a1 @b22 @c333 @d4444 @e5555 @f6666 @g7777', [ 'b22', 'c333', 'd4444', 'e5555', 'f6666' ] ],
		[ "line one\n@arta line two", [ 'arta' ] ],
		[ 'no mention here', [] ],
	];
	foreach ( $cases as [ $text, $want ] ) { t_ok( Arta::extract_handles( $text ) === $want, 'extract_handles ' . json_encode( $text ) ); }
	t_ok( Arta::mentions_arta( 'yo @ArtaBot' ) && ! Arta::mentions_arta( 'artaquest.com/@arta' ), 'mentions_arta honours the alias and ignores paths' );

	foreach ( [ 'arta', 'artabot', 'arta-bot', 'arta_ai', 'theArta', 'the-arta', 'arta-official', 'arta2', 'arta-support', 'ARTA' ] as $h ) {
		t_ok( Arta::is_reserved( str_replace( '_', '-', $h ) ), "is_reserved($h)" );
	}
	foreach ( [ 'artaquest-fan', 'martha', 'arta-smith', 'artan', 'bartab' ] as $h ) { t_ok( ! Arta::is_reserved( $h ), "not reserved($h)" ); }

	t_ok( Arta::is_bug_prefix( '@arta bug: the feed is blank' ), 'bug prefix after a mention' );
	t_ok( Arta::is_bug_prefix( 'Hey @arta, [bug] login loops' ), 'bracketed bug prefix after a greeting' );
	t_ok( Arta::is_bug_prefix( '#bug wallet shows NaN' ), 'hashtag bug prefix' );
	t_ok( ! Arta::is_bug_prefix( '@arta is debugging hard?' ), 'no false bug prefix' );
	t_ok( ! Arta::is_bug_prefix( '@arta what bug: is this?' ), 'bug: mid-sentence is not a prefix' );

	t_ok( Arta::limit_verdict( 0, 0, 0, 0 ) === 'ok', 'limit ok' );
	t_ok( Arta::limit_verdict( Arta::USER_PER_HOUR, 0, 0, 0 ) === 'user', 'user hourly limit' );
	t_ok( Arta::limit_verdict( 0, Arta::USER_PER_DAY, 0, 0 ) === 'user', 'user daily limit' );
	t_ok( Arta::limit_verdict( 0, 0, Arta::GLOBAL_PER_HOUR, 0 ) === 'global', 'global hourly limit' );
	t_ok( Arta::limit_verdict( Arta::USER_PER_HOUR, 0, Arta::GLOBAL_PER_HOUR, 0 ) === 'user', 'member limit reported before the global one' );

	$long = str_repeat( 'word ', 100 );
	$c = Arta::clip( $long, 50 );
	t_ok( mb_strlen( $c ) <= 50 && str_ends_with( $c, '…' ), 'clip respects the limit and marks the cut' );
	t_ok( Arta::clip( 'short', 50 ) === 'short', 'clip leaves short text alone' );
	$r = Arta::sanitize_reply( '<b>Hi</b> see https://evil.example/x and https://artaquest.com/works/ and https://github.com/ArtaQuest/artasite/issues/5 and https://github.com/other/repo', 280 );
	t_ok( strpos( $r, '<b>' ) === false, 'sanitize_reply strips markup' );
	t_ok( strpos( $r, 'evil.example' ) === false && strpos( $r, 'github.com/other' ) === false, 'sanitize_reply removes foreign links' );
	t_ok( strpos( $r, 'https://artaquest.com/works/' ) !== false && strpos( $r, 'github.com/ArtaQuest/artasite/issues/5' ) !== false, 'sanitize_reply keeps own links' );
	$r = Arta::sanitize_reply( '“q” https://eksisozluk.com/entry/2066444 https://math.bilkent.edu.tr/faculty.html http://eksisozluk.com/entry/1 https://eksisozluk.com/okan--1 https://evil.edu.tr.example.com/x', 280 );
	t_ok( strpos( $r, 'https://eksisozluk.com/entry/2066444' ) !== false && strpos( $r, 'https://math.bilkent.edu.tr/faculty.html' ) !== false, 'sanitize_reply keeps cited sources' );
	t_ok( substr_count( $r, '[link removed]' ) === 3, 'sanitize_reply removes http, non-entry and look-alike links' );
	$s = Arta::file_sources( '{"photo.jpg":"https://math.bilkent.edu.tr/faculty.html","x.jpg":"https://evil.example/p","y.jpg":"http://en.wikipedia.org/wiki/X","z.jpg":"javascript:alert(1)"}' );
	t_ok( $s === [ 'photo.jpg' => 'https://math.bilkent.edu.tr/faculty.html' ], 'file_sources keeps only https cited photo pages' );
	t_ok( Arta::file_sources( 'not json' ) === [], 'file_sources ignores junk' );

	// ACS e-mail signature, against an independently computed value.
	require $src . 'Mailer.php';
	$key  = base64_encode( 'secret-key-bytes' );
	$h    = \AQ\Mailer::acs_headers( 'POST', '/emails:send?api-version=2023-03-31', 'x.communication.azure.com', '{"a":1}', $key, 'Thu, 08 Oct 2026 10:00:00 GMT' );
	$hash = base64_encode( hash( 'sha256', '{"a":1}', true ) );
	$want = base64_encode( hash_hmac( 'sha256', "POST\n/emails:send?api-version=2023-03-31\nThu, 08 Oct 2026 10:00:00 GMT;x.communication.azure.com;$hash", 'secret-key-bytes', true ) );
	t_ok( $h['x-ms-content-sha256'] === $hash && str_ends_with( $h['Authorization'], 'Signature=' . $want ), 'ACS HMAC-SHA256 request signature' );
	t_ok( \AQ\Mailer::acs_parse( 'endpoint=https://x.communication.azure.com/;accesskey=abc==' ) === [ 'https://x.communication.azure.com', 'abc==' ], 'ACS connection string parses' );
	t_ok( \AQ\Mailer::acs_parse( 'endpoint=http://x/;accesskey=abc' ) === null, 'ACS refuses a non-https endpoint' );

	// ── Part 2: the database paths ────────────────────────────────────────────────────────────
	if ( ! class_exists( 'PDO' ) || ! in_array( 'sqlite', \PDO::getAvailableDrivers(), true ) ) {
		echo "SKIP  database cases — pdo_sqlite is not installed (CI has it)\n";
		echo "\n" . ( $fails ? "✗ $fails FAILED" : '✓ pure cases pass' ) . "  $passes passed, database cases SKIPPED\n";
		exit( $fails ? 1 : 2 );
	}
	$pdo = new \PDO( 'sqlite::memory:' );
	$pdo->setAttribute( \PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION );
	$GLOBALS['wpdb'] = new \T_Wpdb( $pdo );
	// The production DDL's keys, in SQLite dialect. UNIQUE(src_type, src_id, target_uid) is the
	// idempotency guarantee under test, so it is copied exactly.
	$pdo->exec( "CREATE TABLE wp_aq_mentions (id INTEGER PRIMARY KEY AUTOINCREMENT, src_type TEXT NOT NULL DEFAULT 'post', src_id INTEGER NOT NULL DEFAULT 0,
		ctx_type TEXT NOT NULL DEFAULT 'post', ctx_id INTEGER NOT NULL DEFAULT 0, author_id INTEGER NOT NULL DEFAULT 0, target_uid INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'queued', hint TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', claimed_at INTEGER NOT NULL DEFAULT 0, reply_type TEXT NOT NULL DEFAULT '', reply_id INTEGER NOT NULL DEFAULT 0,
		issue_url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
		UNIQUE (src_type, src_id, target_uid))" );
	$pdo->exec( 'CREATE TABLE wp_aq_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER, body TEXT, parent_id INTEGER DEFAULT 0, reply_count INTEGER DEFAULT 0, created INTEGER)' );
	$pdo->exec( "CREATE TABLE wp_aq_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, context_type TEXT, context_id INTEGER, course_id INTEGER DEFAULT 0, parent_id INTEGER DEFAULT 0,
		author_id INTEGER, body TEXT, lang TEXT DEFAULT 'en', reply_count INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, modq INTEGER DEFAULT 0, created INTEGER)" );
	$pdo->exec( 'CREATE TABLE wp_aq_threads (id INTEGER PRIMARY KEY, title TEXT, body TEXT, comment_count INTEGER DEFAULT 0)' );
	$pdo->exec( 'CREATE TABLE wp_aq_post_media (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, lib_id INTEGER, pos INTEGER DEFAULT 0, created INTEGER DEFAULT 0)' );
	$pdo->exec( "CREATE TABLE wp_aq_library (id INTEGER PRIMARY KEY AUTOINCREMENT, nb_id INTEGER, name TEXT, label TEXT DEFAULT '', mime TEXT, bytes INTEGER, cdn_key TEXT)" );
	$pdo->exec( "CREATE TABLE wp_aq_notebooks (id INTEGER PRIMARY KEY, status TEXT, comments INTEGER DEFAULT 0)" );
	$pdo->exec( "CREATE TABLE wp_aq_arta_files (id INTEGER PRIMARY KEY AUTOINCREMENT, mention_id INTEGER, reply_type TEXT, reply_id INTEGER, pos INTEGER, name TEXT, class TEXT, mime TEXT, bytes INTEGER, sha256 TEXT, cdn_key TEXT, source_url TEXT DEFAULT '', created INTEGER)" );
	$pdo->exec( "CREATE TABLE wp_aq_arta_dm (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, from_arta INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, mention_id INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0)" );
	$GLOBALS['T_OPTS']['aq_arta_table_version'] = Arta::TABLE_VERSION; // the table above stands in for dbDelta's
	$mk = function ( $id, $slug, $name, $bot = false ) {
		$u = (object) [ 'ID' => $id, 'user_nicename' => $slug, 'user_login' => $slug, 'display_name' => $name, 'meta' => $bot ? [ '_aq_is_bot' => 1 ] : [] ];
		$GLOBALS['T_USERS'][ $id ] = $u;
	};
	$mk( 9000, 'arta', 'Arta', true ); $mk( 4, 'dee', 'Dee' ); $mk( 1, 'ada', 'Ada' ); $mk( 2, 'bob', 'Bob' ); $mk( 3, 'cy', 'Cy' );
	$GLOBALS['T_OPTS']['aq_artabot_uid'] = 9000;
	$GLOBALS['T_SECRETS'] = [ 'AQ_ARTA_REPLY_TOKEN' => str_repeat( 't', 40 ) ];
	$post = function ( $uid, $body, $parent = 0 ) { return \AQ\Data::insert( 'aq_posts', [ 'author_id' => $uid, 'body' => $body, 'parent_id' => $parent, 'created' => time() ] ); };
	$count = fn( $where = '1=1' ) => (int) $pdo->query( "SELECT COUNT(*) FROM wp_aq_mentions WHERE $where" )->fetchColumn();

	// Idempotency: the same source recorded three times is ONE row and ONE webhook.
	$p1 = $post( 1, '@arta what is overfitting? cc @bob' );
	$m1 = Arta::record( 'post', $p1, 1, '@arta what is overfitting? cc @bob', 'post', $p1 );
	Arta::record( 'post', $p1, 1, '@arta what is overfitting? cc @bob', 'post', $p1 );
	Arta::record( 'post', $p1, 1, '@arta what is overfitting? cc @bob', 'post', $p1 );
	t_ok( $m1 > 0 && $count() === 1, 'a source is queued once however often it is recorded' );
	t_ok( count( $GLOBALS['T_HTTP'] ) === 0, 'and nothing is pushed anywhere (the brain pulls)' );
	t_ok( count( array_filter( $GLOBALS['T_NOTIFY'], fn( $n ) => $n['uid'] === 2 && $n['type'] === 'mention' ) ) >= 1, 'a mentioned member is notified' );

	// The brain's poll: what it pulls is public data only, and the poll is its heartbeat.
	t_ok( Arta::public_status( [] )['online'] === false, 'before any poll the brain is not online' );
	$pend = Arta::pending( [ 'limit' => 10, 'paused_until' => 0 ] );
	$payload = [ 'mention' => $pend['items'][0] ?? [] ];
	$raw = wp_json_encode( $pend );
	t_ok( count( $pend['items'] ) === 1 && $payload['mention']['source']['author']['handle'] === 'ada' && strpos( $raw, '@' . 'example' ) === false && ! isset( $payload['mention']['source']['author']['email'] ), 'pending is public: handle and name only' );
	t_ok( $payload['mention']['source']['url'] === 'https://artaquest.com/works/?post=' . $p1, 'payload links the post' );
	$st = Arta::public_status( [] );
	t_ok( $st['online'] === true && $st['paused_until'] === 0 && $st['queued'] === 1, 'a poll marks the brain online; the queue is counted' );
	Arta::pending( [ 'limit' => 10, 'paused_until' => time() + 600 ] );
	t_ok( Arta::public_status( [] )['paused_until'] > time(), 'a paused brain says when it is back' );
	Arta::pending( [ 'limit' => 10 ] );
	$GLOBALS['T_OPTS']['aq_arta_beat'] = time() - Arta::BEAT_FRESH - 5;
	t_ok( Arta::public_status( [] )['online'] === false, 'a brain silent past BEAT_FRESH is offline' );

	// Arta never answers itself, and bots never trigger it.
	$p2 = $post( 9000, '@arta talking to myself' );
	t_ok( Arta::record( 'post', $p2, 9000, '@arta talking to myself', 'post', $p2 ) === 0, 'Arta does not answer itself' );
	t_ok( Arta::record( 'post', 99, 1, 'no mention', 'post', 99 ) === 0, 'text without a mention records nothing' );

	// Rate limit: after USER_PER_HOUR live mentions in an hour the next one is 'limited' + noticed.
	for ( $i = 0; $i < Arta::USER_PER_HOUR; $i++ ) { $pid = $post( 3, "@arta q$i" ); Arta::record( 'post', $pid, 3, "@arta q$i", 'post', $pid ); }
	$pl = $post( 3, '@arta one too many' );
	$ml = Arta::record( 'post', $pl, 3, '@arta one too many', 'post', $pl );
	$row = \AQ\Data::one( 'SELECT * FROM wp_aq_mentions WHERE id = %d', [ $ml ] );
	t_ok( $count( 'author_id = 3' ) === Arta::USER_PER_HOUR + 1 && $row['status'] === 'limited' && $row['note'] === 'limit:user', 'the member\'s next mention past the hourly limit is limited' );
	t_ok( count( array_filter( $GLOBALS['T_NOTIFY'], fn( $n ) => $n['uid'] === 3 && $n['type'] === 'arta' ) ) === 1, 'and the member is told once' );
	t_ok( ! in_array( $ml, array_column( Arta::pending( [ 'limit' => 50 ] )['items'], 'id' ), true ), 'a limited mention is never offered to the brain' );

	// Claim: exactly one caller wins.
	$c1 = Arta::claim( [ 'id' => $m1 ] );
	$c2 = Arta::claim( [ 'id' => $m1 ] );
	t_ok( ! empty( $c1['ok'] ) && ( $c2['status'] ?? 0 ) === 409, 'a claim is exclusive (second caller 409)' );
	t_ok( ( Arta::claim( [ 'id' => 999999 ] )['status'] ?? 0 ) === 404, 'claiming a missing mention is 404' );

	// Reply: written once; a retry is a harmless duplicate; status cannot undo it.
	$r1 = Arta::reply( [ 'mention_id' => $m1, 'body' => 'Overfitting is <i>memorising</i> noise. https://phish.example', 'kind' => 'answer' ] );
	$r2 = Arta::reply( [ 'mention_id' => $m1, 'body' => 'a second answer' ] );
	$replies = (int) $pdo->query( "SELECT COUNT(*) FROM wp_aq_posts WHERE parent_id = $p1 AND author_id = 9000" )->fetchColumn();
	$stored  = (string) $pdo->query( "SELECT body FROM wp_aq_posts WHERE parent_id = $p1 AND author_id = 9000" )->fetchColumn();
	t_ok( ! empty( $r1['ok'] ) && empty( $r1['duplicate'] ) && ! empty( $r2['duplicate'] ) && $replies === 1, 'a reply is written exactly once; a retry is duplicate:true' );
	t_ok( strpos( $stored, '<i>' ) === false && strpos( $stored, 'phish.example' ) === false, 'the stored reply is sanitised' );
	t_ok( (int) $pdo->query( "SELECT reply_count FROM wp_aq_posts WHERE id = $p1" )->fetchColumn() === 1, 'the parent post counts the reply' );
	t_ok( count( array_filter( $GLOBALS['T_NOTIFY'], fn( $n ) => $n['uid'] === 1 && $n['title'] === 'Arta replied to you' ) ) === 1, 'the asker is notified of the reply' );
	t_ok( ( Arta::status( [ 'id' => $m1, 'status' => 'failed' ] )['status'] ?? 0 ) === 409, 'a replied mention cannot be marked failed' );
	t_ok( ( Arta::claim( [ 'id' => $m1 ] )['status'] ?? 0 ) === 409, 'a replied mention cannot be claimed again' );

	// Bug report: issue link validated, ticket mirrored.
	$pb = $post( 2, '@arta bug: the wallet shows NaN coins after a refund' );
	$mb = Arta::record( 'post', $pb, 2, '@arta bug: the wallet shows NaN coins after a refund', 'post', $pb );
	t_ok( \AQ\Data::one( 'SELECT hint FROM wp_aq_mentions WHERE id = %d', [ $mb ] )['hint'] === 'bug', 'a bug: mention is hinted as a bug' );
	Arta::claim( [ 'id' => $mb ] );
	$rb = Arta::reply( [ 'mention_id' => $mb, 'body' => 'Thanks — filed as https://github.com/ArtaQuest/artasite/issues/42', 'kind' => 'bug', 'issue_url' => 'https://github.com/ArtaQuest/artasite/issues/42', 'issue_title' => 'Wallet shows NaN' ] );
	$rowb = \AQ\Data::one( 'SELECT * FROM wp_aq_mentions WHERE id = %d', [ $mb ] );
	t_ok( ! empty( $rb['ok'] ) && $rowb['issue_url'] === 'https://github.com/ArtaQuest/artasite/issues/42' && count( \AQ\Tickets::$opened ) === 1, 'a bug reply stores the issue and mirrors a ticket' );
	$pe = $post( 2, '@arta bug: another' ); $me = Arta::record( 'post', $pe, 2, '@arta bug: another', 'post', $pe );
	Arta::reply( [ 'mention_id' => $me, 'body' => 'ok', 'kind' => 'bug', 'issue_url' => 'https://github.com/evil/repo/issues/1' ] );
	t_ok( \AQ\Data::one( 'SELECT issue_url FROM wp_aq_mentions WHERE id = %d', [ $me ] )['issue_url'] === '' && count( \AQ\Tickets::$opened ) === 1, 'a foreign issue URL is dropped' );

	// Comments: Arta's reply nests under the comment, in the same thread.
	$pdo->exec( "INSERT INTO wp_aq_threads (id, title, body) VALUES (7, 'Kaggle help', 'thread body')" );
	\AQ\Data::insert( 'aq_comments', [ 'context_type' => 'thread', 'context_id' => 7, 'author_id' => 2, 'body' => '@arta how do I cite a dataset?', 'created' => time() ] );
	$cid = (int) $pdo->lastInsertId();
	$mc = Arta::record( 'comment', $cid, 2, '@arta how do I cite a dataset?', 'thread', 7 );
	$cl = Arta::claim( [ 'id' => $mc ] );
	t_ok( ( $cl['mention']['context'][0]['title'] ?? '' ) === 'Kaggle help', 'a comment mention carries its thread as context' );
	Arta::reply( [ 'mention_id' => $mc, 'body' => 'Use the DOI on the dataset page.' ] );
	$cr = $pdo->query( "SELECT * FROM wp_aq_comments WHERE author_id = 9000" )->fetch( \PDO::FETCH_ASSOC );
	t_ok( $cr && (int) $cr['parent_id'] === $cid && $cr['context_type'] === 'thread' && (int) $cr['context_id'] === 7, 'a comment reply nests under the mention' );
	t_ok( (int) $pdo->query( 'SELECT comment_count FROM wp_aq_threads WHERE id = 7' )->fetchColumn() === 1, 'the thread counts the reply' );

	// A flagged (moderated) comment is skipped, not answered.
	\AQ\Data::insert( 'aq_comments', [ 'context_type' => 'thread', 'context_id' => 7, 'author_id' => 2, 'body' => '@arta something hateful', 'flagged' => 1, 'created' => time() ] );
	$fid = (int) $pdo->lastInsertId();
	$mf = Arta::record( 'comment', $fid, 2, '@arta something hateful', 'thread', 7 );
	t_ok( ( Arta::claim( [ 'id' => $mf ] )['status'] ?? 0 ) === 410, 'a flagged comment is not answered (410, skipped)' );

	// Housekeeping: a stale claim returns to the queue (and nothing is ever pushed).
	$pq = $post( 1, '@arta second question' ); $mq = Arta::record( 'post', $pq, 1, '@arta second question', 'post', $pq );
	Arta::claim( [ 'id' => $mq ] );
	Arta::reconcile_tick();
	t_ok( \AQ\Data::one( 'SELECT status FROM wp_aq_mentions WHERE id = %d', [ $mq ] )['status'] === 'working', 'a fresh claim is left alone' );
	$pdo->exec( 'UPDATE wp_aq_mentions SET claimed_at = ' . ( time() - Arta::CLAIM_TTL - 5 ) . " WHERE id = $mq" );
	Arta::reconcile_tick();
	t_ok( \AQ\Data::one( 'SELECT status FROM wp_aq_mentions WHERE id = %d', [ $mq ] )['status'] === 'queued' && count( $GLOBALS['T_HTTP'] ) === 0, 'housekeeping requeues a stale claim, pushes nothing' );
	$pdo->exec( 'UPDATE wp_aq_mentions SET created = ' . ( time() - Arta::MAX_AGE - 5 ) . " WHERE id = $mq" );
	Arta::reconcile_tick();
	t_ok( \AQ\Data::one( 'SELECT status FROM wp_aq_mentions WHERE id = %d', [ $mq ] )['status'] === 'expired', 'a mention older than MAX_AGE expires' );

	// ── Files IN: a reply under a picture carries the picture (and the caps hold) ──────────────────
	$pdo->exec( "INSERT INTO wp_aq_notebooks (id, status) VALUES (50, 'published'), (51, 'draft')" );
	$lib = function ( $nb, $name, $mime, $bytes ) use ( $pdo ) {
		\AQ\Data::insert( 'aq_library', [ 'nb_id' => $nb, 'name' => "output/$name", 'label' => '', 'mime' => $mime, 'bytes' => $bytes, 'cdn_key' => "lib/$name" ] );
		return (int) $pdo->lastInsertId();
	};
	$pp = $post( 2, 'look at my plot' );
	$files_on_pp = [
		$lib( 50, 'plot.png', 'image/png', 120000 ),
		$lib( 50, 'huge.png', 'image/png', Arta::ATTACH_BYTES + 1 ),
		$lib( 50, 'model.zip', 'application/zip', 5000 ),
		$lib( 51, 'draft.png', 'image/png', 100 ),          // unpublished work: never offered
		$lib( 50, 'b.jpg', 'image/jpeg', 10 ), $lib( 50, 'c.webp', 'image/webp', 10 ), $lib( 50, 'd.pdf', 'application/pdf', 10 ),
		$lib( 50, 'e.csv', 'text/csv', 10 ),
	];
	foreach ( $files_on_pp as $pos => $lid ) { \AQ\Data::insert( 'aq_post_media', [ 'post_id' => $pp, 'lib_id' => $lid, 'pos' => $pos, 'created' => time() ] ); }
	$pr = $post( 1, "@arta what's this?", $pp );
	$mr = Arta::record( 'post', $pr, 1, "@arta what's this?", 'post', $pr );
	$att = Arta::claim( [ 'id' => $mr ] )['mention']['attachments'] ?? [];
	$by  = array_column( $att, null, 'name' );
	t_ok( isset( $by['plot.png'] ) && $by['plot.png']['url'] === 'https://cdn.test/lib/plot.png' && $by['plot.png']['mime'] === 'image/png' && $by['plot.png']['bytes'] === 120000 && $by['plot.png']['from'] === 'parent' && $by['plot.png']['skip'] === '', 'a reply under a picture carries the parent post\'s file (url, mime, size, name)' );
	t_ok( ( $by['huge.png']['skip'] ?? '' ) === 'size' && ( $by['model.zip']['skip'] ?? '' ) === 'type', 'oversized and unsupported files are listed with the reason, not handed over' );
	t_ok( ! isset( $by['draft.png'] ), 'a file from an unpublished work is never offered' );
	t_ok( count( array_filter( $att, fn( $a ) => $a['skip'] === '' ) ) === Arta::ATTACH_MAX && ( $by['e.csv']['skip'] ?? '' ) === 'count', 'at most ATTACH_MAX files are handed over; the rest say count' );
	$pend_att = array_values( array_filter( Arta::pending( [ 'status' => 'working', 'limit' => 50 ] )['items'], fn( $i ) => $i['id'] === $mr ) );
	t_ok( isset( $pend_att[0]['attachments'] ) && count( $pend_att[0]['attachments'] ) === count( $att ), 'pending carries the same attachments' );

	// ── Files OUT: sniffed, capped, stored once, rendered like attachments ──────────────────────────
	$tmpf = function ( $bytes ) { $f = tempnam( sys_get_temp_dir(), 'arta' ); file_put_contents( $f, $bytes ); return $f; };
	$png  = base64_decode( 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' );
	t_ok( Arta::sniff( $tmpf( $png ), 'x.bin' ) === 'image/png', 'sniff: PNG by its bytes, whatever the name' );
	t_ok( Arta::sniff( $tmpf( "<svg onload=alert(1)></svg>" ), 'a.md' ) === '' && Arta::sniff( $tmpf( "<!DOCTYPE html><script>x</script>" ), 'a.txt' ) === '', 'sniff: SVG/HTML refused even as text' );
	t_ok( Arta::sniff( $tmpf( "MZ\x90\x00\x03\x00\x00\x00" ), 'a.png' ) === '' && Arta::sniff( $tmpf( "PK\x03\x04zip" ), 'a.txt' ) === '', 'sniff: executables and archives refused' );
	t_ok( Arta::sniff( $tmpf( "\x89PNG\r\n\x1a\nnot really" ), 'a.png' ) === '', 'sniff: a PNG header on junk is refused' );
	t_ok( Arta::sniff( $tmpf( '{"a":1}' ), 'a.json' ) === 'application/json' && Arta::sniff( $tmpf( '{broken' ), 'a.json' ) === '', 'sniff: JSON must parse' );
	t_ok( Arta::sniff( $tmpf( "# Answer\n\nfull text ✓" ), 'answer.md' ) === 'text/markdown', 'sniff: UTF-8 Markdown accepted' );

	$pf = $post( 3, '@arta draw a square' ); $mf2 = Arta::record( 'post', $pf, 3, '@arta draw a square', 'post', $pf );
	Arta::claim( [ 'id' => $mf2 ] );
	$up = [ 'files' => [
		[ 'name' => 'square.png', 'tmp_name' => $tmpf( $png ), 'error' => 0 ],
		[ 'name' => 'answer.md', 'tmp_name' => $tmpf( "# Full answer\n\n```py\nprint(1)\n```\n" ), 'error' => 0 ],
		[ 'name' => 'evil.png', 'tmp_name' => $tmpf( '<html><script>alert(1)</script>' ), 'error' => 0 ],
		[ 'name' => 'tool.exe', 'tmp_name' => $tmpf( "MZ\x90\x00" ), 'error' => 0 ],
	] ];
	$rf = Arta::reply( [ 'mention_id' => $mf2, 'body' => 'Here is your square (full answer attached).', 'kind' => 'answer', 'sources' => '{"square.png":"https://en.wikipedia.org/wiki/Square","answer.md":"https://evil.example/x"}', '_files' => $up ] );
	$reply_post = (int) $pdo->query( "SELECT id FROM wp_aq_posts WHERE parent_id = $pf AND author_id = 9000" )->fetchColumn();
	$cards = Arta::files_for( 'post', $reply_post );
	t_ok( ! empty( $rf['ok'] ) && $rf['files'] === 2 && count( $rf['dropped'] ) === 2, 'reply stores the two valid files and names the two refused' );
	t_ok( count( $cards ) === 2 && $cards[0]['class'] === 'image' && $cards[0]['mime'] === 'image/png' && $cards[1]['class'] === 'doc' && $cards[1]['name'] === 'answer.md' && $cards[0]['id'] < 0, 'the reply renders them as attachment cards (image, doc)' );
	t_ok( $cards[0]['source'] === 'https://en.wikipedia.org/wiki/Square' && $cards[1]['source'] === '', 'a photo keeps its cited source page; a foreign source is dropped' );
	t_ok( isset( \AQ\Media::$stored[ 'arta/' . hash( 'sha256', $png ) . '.png' ] ) && count( \AQ\Media::$stored ) === 2, 'files land content-addressed in the media store, nothing refused is stored' );
	$rf2 = Arta::reply( [ 'mention_id' => $mf2, 'body' => 'again', '_files' => $up ] );
	t_ok( ! empty( $rf2['duplicate'] ) && count( Arta::files_for( 'post', $reply_post ) ) === 2 && count( \AQ\Media::$stored ) === 2, 'a retried reply stores no second copy' );
	$many = [ 'files' => [ 'name' => [ 'a.png', 'b.png', 'c.png', 'd.png', 'e.png' ], 'tmp_name' => array_map( fn() => $tmpf( $png ), range( 1, 5 ) ), 'error' => [ 0, 0, 0, 0, 0 ] ] ];
	[ $okf, $drop ] = Arta::reply_files( [ '_files' => $many ] );
	t_ok( count( $okf ) === Arta::REPLY_FILES_MAX && count( $drop ) === 1, 'PHP files[] shape parsed; at most REPLY_FILES_MAX files per reply' );

	\AQ\Data::insert( 'aq_comments', [ 'context_type' => 'thread', 'context_id' => 7, 'author_id' => 1, 'body' => '@arta make a diagram', 'created' => time() ] );
	$cid2 = (int) $pdo->lastInsertId();
	$mc2 = Arta::record( 'comment', $cid2, 1, '@arta make a diagram', 'thread', 7 );
	Arta::claim( [ 'id' => $mc2 ] );
	Arta::reply( [ 'mention_id' => $mc2, 'body' => 'Here it is.', '_files' => [ 'files' => [ [ 'name' => 'diagram.png', 'tmp_name' => $tmpf( $png ), 'error' => 0 ] ] ] ] );
	$cbody = (string) $pdo->query( "SELECT body FROM wp_aq_comments WHERE author_id = 9000 AND parent_id = $cid2" )->fetchColumn();
	t_ok( strpos( $cbody, "Files:\ndiagram.png — https://cdn.test/arta/" ) !== false, 'a comment reply lists its files as links under the text' );

	// arta/watch: one thread's mentions, as statuses and queue positions only.
	$GLOBALS['T_OPTS']['aq_arta_beat'] = time();
	$pw  = $post( 1, 'a thread about priors' );
	$pw1 = $post( 41, '@arta what is a prior?', $pw );
	$pw2 = $post( 42, '@arta and a posterior?', $pw );
	$mw1 = Arta::record( 'post', $pw1, 41, '@arta what is a prior?', 'post', $pw );
	$mw2 = Arta::record( 'post', $pw2, 42, '@arta and a posterior?', 'post', $pw );
	$w   = Arta::watch( [ 'id' => $pw ] );
	$by  = array_column( $w['items'], null, 'post_id' );
	$raw = wp_json_encode( $w );
	t_ok( count( $w['items'] ) === 2 && $by[ $pw1 ]['status'] === 'queued' && $by[ $pw2 ]['status'] === 'queued', 'watch lists every mention in the thread' );
	t_ok( $by[ $pw2 ]['position'] === $by[ $pw1 ]['position'] + 1 && $by[ $pw1 ]['position'] >= 1, 'watch gives queue positions in order' );
	t_ok( strpos( $raw, 'prior' ) === false && strpos( $raw, 'author' ) === false, 'watch carries no text and no author' );
	Arta::claim( [ 'id' => $mw1 ] );
	t_ok( array_column( Arta::watch( [ 'id' => $pw ] )['items'], null, 'post_id' )[ $pw1 ]['status'] === 'working', 'a claimed mention reads as working' );
	Arta::reply( [ 'mention_id' => $mw1, 'body' => 'A prior is what you believed before the data.' ] );
	$after = array_column( Arta::watch( [ 'id' => $pw ] )['items'], null, 'post_id' );
	t_ok( $after[ $pw1 ]['status'] === 'replied' && $after[ $pw1 ]['reply_id'] > 0 && $after[ $pw2 ]['position'] >= 1, 'a replied mention carries its reply id; the next one keeps its place' );
	t_ok( Arta::watch( [ 'id' => 0 ] )['items'] === [] && Arta::watch( [ 'id' => 987654 ] )['items'] === [], 'watch on nothing is empty, not an error' );
	t_ok( strpos( Arta::avatar_url(), '/assets/arta/arta-thinking.svg' ) !== false, 'Arta wears the thinking mascot' );
	t_ok( Arta::display_mentions( 'Hey @arta how?' ) === 'Hey Arta how?', 'a mention reads as "Arta"' );
	t_ok( Arta::display_mentions( '@Arta bug: x' ) === 'Arta bug: x' && Arta::display_mentions( '@artabot hi' ) === 'Arta hi', 'any case, and the old alias' );
	t_ok( Arta::display_mentions( 'x@arta.com, @artas, see @arta.com' ) === 'x@arta.com, @artas, see @arta.com', 'emails, longer handles and domains are left alone' );

	// PRIVATE chat: a member's question is queued like a mention, the payload is marked private and
	// carries only that member's own earlier turns, the answer lands in THEIR chat (never a public
	// post), files are refused, nobody else can read it, and clearing it drops the pending question.
	\AQ\Rest::$uid = 4;
	$d0 = Arta::dm_send( [ 'body' => '' ] );
	t_ok( ( $d0['error'] ?? '' ) === 'empty', 'private chat: an empty message is refused' );
	$d1 = Arta::dm_send( [ 'body' => 'Privately: <b>how</b> do I cite a dataset?' ] );
	t_ok( ! empty( $d1['ok'] ) && $d1['status'] === 'queued' && $d1['item']['body'] === 'Privately: how do I cite a dataset?', 'private chat: a question is stored (tags stripped) and queued' );
	$dm = (int) $pdo->query( "SELECT id FROM wp_aq_mentions WHERE src_type = 'dm' AND author_id = 4" )->fetchColumn();
	$pp = array_values( array_filter( Arta::pending( [ 'limit' => 50 ] )['items'], fn( $i ) => $i['id'] === $dm ) );
	t_ok( $pp && $pp[0]['private'] === true && $pp[0]['source']['type'] === 'dm' && $pp[0]['max_chars'] === Arta::DM_MAX && $pp[0]['attachments'] === [], 'private chat: the brain gets it, marked private, no files' );
	$posts_before = (int) $pdo->query( 'SELECT COUNT(*) FROM wp_aq_posts' )->fetchColumn();
	Arta::claim( [ 'id' => $dm ] );
	$dr = Arta::reply( [ 'mention_id' => $dm, 'body' => 'Use the DOI on its page.', '_files' => [ 'files' => [ [ 'name' => 'x.png', 'tmp_name' => $tmpf( $png ), 'error' => 0 ] ] ] ] );
	t_ok( ! empty( $dr['ok'] ) && $dr['reply_type'] === 'dm' && (int) $pdo->query( 'SELECT COUNT(*) FROM wp_aq_posts' )->fetchColumn() === $posts_before, 'private chat: the answer is not a public post' );
	t_ok( ( $dr['files'] ?? -1 ) === 0 && (int) $pdo->query( "SELECT COUNT(*) FROM wp_aq_arta_files WHERE reply_type = 'dm'" )->fetchColumn() === 0, 'private chat: files are refused (the media store is public)' );
	$l2 = Arta::dm_list( [] );
	t_ok( count( $l2['items'] ) === 2 && $l2['items'][1]['from_arta'] === true && $l2['items'][1]['body'] === 'Use the DOI on its page.' && $l2['pending'] === null, 'private chat: the member sees both turns, nothing pending' );
	t_ok( Arta::reply( [ 'mention_id' => $dm, 'body' => 'again' ] )['duplicate'] === true && count( Arta::dm_list( [] )['items'] ) === 2, 'private chat: answered exactly once' );
	\AQ\Rest::$uid = 1;
	t_ok( Arta::dm_list( [] )['items'] === [], 'private chat: another member cannot see it' );
	\AQ\Rest::$uid = 4;
	Arta::dm_send( [ 'body' => 'and a follow-up' ] );
	$dm2 = (int) $pdo->query( "SELECT MAX(id) FROM wp_aq_mentions WHERE src_type = 'dm' AND author_id = 4" )->fetchColumn();
	$pl2 = Arta::claim( [ 'id' => $dm2 ] )['mention'];
	t_ok( count( $pl2['context'] ) === 2 && $pl2['context'][1]['author']['is_arta'] === true, 'private chat: earlier turns travel as context' );
	Arta::status( [ 'id' => $dm2, 'status' => 'queued' ] );
	$cl = Arta::dm_clear( [] );
	t_ok( $cl['deleted'] === 3 && Arta::dm_list( [] )['items'] === [] && $pdo->query( "SELECT status FROM wp_aq_mentions WHERE id = $dm2" )->fetchColumn() === 'skipped', 'private chat: clearing deletes it and drops the pending question' );

	// The brain's token check: closed by default, constant-time, header or Bearer.
	$_SERVER['HTTP_X_ARTA_TOKEN'] = str_repeat( 't', 40 ); t_ok( Arta::token_ok(), 'token accepted via X-Arta-Token' );
	$_SERVER['HTTP_X_ARTA_TOKEN'] = 'wrong'; t_ok( ! Arta::token_ok(), 'wrong token refused' );
	unset( $_SERVER['HTTP_X_ARTA_TOKEN'] ); $_SERVER['HTTP_AUTHORIZATION'] = 'Bearer ' . str_repeat( 't', 40 ); t_ok( Arta::token_ok(), 'token accepted via Bearer' );
	$GLOBALS['T_SECRETS']['AQ_ARTA_REPLY_TOKEN'] = 'short'; t_ok( ! Arta::token_ok(), 'a short configured token disables the API' );

	echo "\n" . ( $fails ? "✗ $fails FAILED" : '✓ ALL PASS' ) . "  $passes/" . ( $passes + $fails ) . " assertions\n";
	exit( $fails ? 1 : 0 );
}
