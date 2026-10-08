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
	final class Notify { public static function push( $uid, $type, $title, $body = '', $url = '', $key = '' ) { $GLOBALS['T_NOTIFY'][] = compact( 'uid', 'type', 'title', 'body', 'url', 'key' ); } }
	final class Tickets { public static $opened = []; public static function open_from_arta( ...$a ) { self::$opened[] = $a; return 1; } }
	final class Rest {
		public static function p( $req, $k, $d = null ) { return $req[ $k ] ?? $d; }
		public static function pint( $req, $k, $d = 0 ) { return (int) ( $req[ $k ] ?? $d ); }
		public static function err( $code, $msg, $status = 400 ) { return [ 'error' => $code, 'message' => $msg, 'status' => $status ]; }
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
	$GLOBALS['T_OPTS']['aq_arta_table_version'] = Arta::TABLE_VERSION; // the table above stands in for dbDelta's
	$mk = function ( $id, $slug, $name, $bot = false ) {
		$u = (object) [ 'ID' => $id, 'user_nicename' => $slug, 'user_login' => $slug, 'display_name' => $name, 'meta' => $bot ? [ '_aq_is_bot' => 1 ] : [] ];
		$GLOBALS['T_USERS'][ $id ] = $u;
	};
	$mk( 9000, 'arta', 'Arta', true ); $mk( 1, 'ada', 'Ada' ); $mk( 2, 'bob', 'Bob' ); $mk( 3, 'cy', 'Cy' );
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

	// The brain's token check: closed by default, constant-time, header or Bearer.
	$_SERVER['HTTP_X_ARTA_TOKEN'] = str_repeat( 't', 40 ); t_ok( Arta::token_ok(), 'token accepted via X-Arta-Token' );
	$_SERVER['HTTP_X_ARTA_TOKEN'] = 'wrong'; t_ok( ! Arta::token_ok(), 'wrong token refused' );
	unset( $_SERVER['HTTP_X_ARTA_TOKEN'] ); $_SERVER['HTTP_AUTHORIZATION'] = 'Bearer ' . str_repeat( 't', 40 ); t_ok( Arta::token_ok(), 'token accepted via Bearer' );
	$GLOBALS['T_SECRETS']['AQ_ARTA_REPLY_TOKEN'] = 'short'; t_ok( ! Arta::token_ok(), 'a short configured token disables the API' );

	echo "\n" . ( $fails ? "✗ $fails FAILED" : '✓ ALL PASS' ) . "  $passes/" . ( $passes + $fails ) . " assertions\n";
	exit( $fails ? 1 : 0 );
}
