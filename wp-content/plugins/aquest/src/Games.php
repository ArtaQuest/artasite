<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaRPS — one wheel, twelve tools, thrown all at once.
 *
 * Each round both players throw any unspent tool (a hand sign); the payoff table REWARD_BY_DIR
 * is keyed by wheel distance: 2 or 4 steps apart pays BOTH (+2 / +3 — alliances), 3 steps is the
 * one zero-sum duel (+2/-2, the tool three steps BEHIND wins — the Twelve Laws, LAWS_EN), and
 * everything else clashes (-2 both). Every tool is thrown exactly once, highest total wins, so
 * the differential comes entirely from the duels.
 *
 * FOUR ARENAS. Advanced = the full WHEEL (12 tools, 12 rounds). Easy = one of the three RINGS —
 * the duel cycles that partition the wheel (each tool takes the next, the fourth takes the
 * first; opposites clash): gun→cup→wedge→rock · plow→bolt→hook→saw · scissors→wheat→arrow→net.
 * 4 tools, 4 rounds, the same payoff table (in-ring distances are 0/3/6/9). (The table is the stability model of
 * our Aspects paper, DOI 10.5281/zenodo.21193195 — engineering provenance only: the member-facing
 * game carries NO astrology; tools, laws and wheel distances are the whole vocabulary.)
 *
 * Chess.com-style: live matches (simultaneous-reveal rounds), a lobby for open rated challenges,
 * practice vs ArtaBot (the paper's "chill" random / "sharp" predicting bot), Elo ratings with a
 * public leaderboard, per-match realtime chat (short-poll), resign + idle-claim.
 *
 * PUBLIC-DATABASE SAFETY: the whole DB is public (/data), so a pending move can never be stored
 * readably or the opponent could peek mid-round. Pending moves are sealed with an HMAC-SHA256
 * keystream XOR (pure PHP — Studio's PHP-WASM has no openssl) keyed from the wp-config salts
 * (never the DB); only the resolver decrypts, and only resolved rounds are ever exposed.
 */
final class Games {

	const IDLE_CLAIM_S = 300; // a waiting player may claim the match after 5 idle minutes
	const LOBBY_TTL_S  = 3600;// open challenges expire from the lobby after an hour
	const ELO_K        = 32;
	const ELO_START    = 1000;

	// ── the clock (chess.com-style) ────────────────────────────────────────────
	// Each player gets a 10-minute bank that ticks only while it is THEIR turn to seal the round
	// (their throw not yet in). A Fischer INCREMENT is added to both after every resolved round —
	// it covers the reveal animation and keeps a careful player from ever flagging on the ceremony.
	// Run out of bank before you seal → you flag → you lose.
	const CLOCK_S     = 600; // 10 minutes
	const INCREMENT_S = 6;   // added to both banks each round (covers the ~4.6s reveal + a beat)

	/** The twelve tools in WHEEL ORDER — position is everything: k beats (k+3) mod 12. */
	const TOOLS = [ 'gun', 'plow', 'scissors', 'cup', 'bolt', 'wheat', 'wedge', 'hook', 'arrow', 'rock', 'saw', 'net' ];
	/** The Twelve Laws — line k names how tool k takes the tool three steps ahead. The SPA
	 *  renders these exact strings (duel verdicts, rules, cards); seed_i18n ships them authored
	 *  in the 20 selector languages. */
	const LAWS_EN = [
		'Gun cracks the Cup', 'Plow grounds the Bolt', 'Scissors shear the Wheat',
		'Cup rusts the Wedge', 'Bolt melts the Hook', 'Wheat swallows the Arrow',
		'Wedge splits the Rock', 'Hook jams the Saw', 'Arrow threads the Net',
		'Rock smashes the Gun', 'Saw cuts the Plow', 'Net binds the Scissors',
	];
	/** The three EASY rings — each a closed duel cycle of four (k, k+3, k+6, k+9), named by its
	 *  lead tool. Kept so pre-existing per-ring matches still resolve; the live catalogue is GAMES. */
	const RINGS = [
		'gun'      => [ 'gun', 'cup', 'wedge', 'rock' ],
		'plow'     => [ 'plow', 'bolt', 'hook', 'saw' ],
		'scissors' => [ 'scissors', 'wheat', 'arrow', 'net' ],
	];

	/**
	 * THE THREE GAMES — a difficulty ladder, one board each (the board key is also the game id).
	 * The only tool-subsets of the wheel that carry real duels (offset 3) are sizes 4, 8 and 12,
	 * so the three sizes ARE the three games. All hand-tools + the Twelve Laws — NO astrology.
	 *   • ring  (4)  — one duel cycle. Quick. Beginner.
	 *   • cross (8)  — two rings interlocked. Alliances AND duels across them. Intermediate.
	 *   • wheel (12) — every tool once. The full game. Advanced.
	 */
	const RING_TOOLS  = [ 'gun', 'cup', 'wedge', 'rock' ];
	const CROSS_TOOLS = [ 'gun', 'cup', 'wedge', 'rock', 'plow', 'bolt', 'hook', 'saw' ];
	const GAMES = [ 'ring', 'cross', 'wheel' ];

	/** Tool set of a board (game id or a legacy ring key). */
	private static function arena_tools( $ring ) {
		switch ( $ring ) {
			case 'ring':  return self::RING_TOOLS;
			case 'cross': return self::CROSS_TOOLS;
			case 'wheel': return self::TOOLS;
			default:      return self::RINGS[ $ring ] ?? self::TOOLS; // legacy per-ring + 'cardinal' fall back sensibly
		}
	}
	/** Rounds on a board — every tool thrown exactly once. */
	public static function arena_rounds( $ring ) {
		return count( self::arena_tools( $ring ) );
	}

	// ── storage ───────────────────────────────────────────────────────────────

	const TABLES_VERSION = '4'; // v4: per-player clocks (clock1/clock2/clock_ts)

	public static function ensure_tables() {
		if ( get_option( 'aq_rps_tables_version' ) === self::TABLES_VERSION ) { return; }
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$m = $wpdb->prefix . 'aq_rps_matches';
		dbDelta( "CREATE TABLE {$m} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			ring VARCHAR(10) NOT NULL DEFAULT 'cardinal',
			mode VARCHAR(12) NOT NULL DEFAULT 'open',
			status VARCHAR(8) NOT NULL DEFAULT 'open',
			rated TINYINT UNSIGNED NOT NULL DEFAULT 0,
			p1 BIGINT UNSIGNED NOT NULL DEFAULT 0,
			p2 BIGINT UNSIGNED NOT NULL DEFAULT 0,
			p1_score SMALLINT NOT NULL DEFAULT 0,
			p2_score SMALLINT NOT NULL DEFAULT 0,
			p1_move VARCHAR(64) NOT NULL DEFAULT '',
			p2_move VARCHAR(64) NOT NULL DEFAULT '',
			rounds LONGTEXT NULL,
			winner TINYINT UNSIGNED NOT NULL DEFAULT 0,
			delta1 SMALLINT NOT NULL DEFAULT 0,
			delta2 SMALLINT NOT NULL DEFAULT 0,
			clock1 INT NOT NULL DEFAULT 600,
			clock2 INT NOT NULL DEFAULT 600,
			clock_ts INT UNSIGNED NOT NULL DEFAULT 0,
			created INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			last_move INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY lobby (status, id),
			KEY p1 (p1, id),
			KEY p2 (p2, id)
		) {$charset};" );
		$c = $wpdb->prefix . 'aq_rps_chat';
		dbDelta( "CREATE TABLE {$c} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			match_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
			body VARCHAR(500) NOT NULL DEFAULT '',
			created INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY match_tail (match_id, id)
		) {$charset};" );
		$p = $wpdb->prefix . 'aq_rps_players';
		dbDelta( "CREATE TABLE {$p} (
			uid BIGINT UNSIGNED NOT NULL,
			rating SMALLINT UNSIGNED NOT NULL DEFAULT 1000,
			wins INT UNSIGNED NOT NULL DEFAULT 0,
			losses INT UNSIGNED NOT NULL DEFAULT 0,
			draws INT UNSIGNED NOT NULL DEFAULT 0,
			games INT UNSIGNED NOT NULL DEFAULT 0,
			updated INT UNSIGNED NOT NULL DEFAULT 0,
			PRIMARY KEY  (uid),
			KEY board (rating, uid)
		) {$charset};" );
		update_option( 'aq_rps_tables_version', self::TABLES_VERSION, true );
		self::seed_i18n();
	}

	// ── rules ─────────────────────────────────────────────────────────────────

	/** Reward to YOU by directed wheel offset d = (them − you) mod 12: alliances at 2 (+2 both)
	 *  and 4 (+3 both) steps; the duel at 3 steps is ±2 zero-sum (d=3 wins, d=9 loses — the
	 *  Twelve Laws); every other distance clashes (−2 both). */
	const REWARD_BY_DIR = [ -2, -2, 2, 2, 3, -2, -2, -2, 3, -2, 2, -2 ];

	/** [your points, their points] for one simultaneous throw — ALL 12 signs in play at once. */
	private static function payoff( $a, $b ) {
		$ia = array_search( $a, self::TOOLS, true ); $ib = array_search( $b, self::TOOLS, true );
		if ( $ia === false || $ib === false ) { return [ 0, 0 ]; }
		return [ self::REWARD_BY_DIR[ ( $ib - $ia + 12 ) % 12 ], self::REWARD_BY_DIR[ ( $ia - $ib + 12 ) % 12 ] ];
	}

	// ── sealed pending moves (public DB!) ────────────────────────────────────

	private static function seal_key() { return hash( 'sha256', wp_salt( 'auth' ) . '|aq-rps-move', true ); }

	private static function seal( $move ) {
		$nonce = random_bytes( 8 );
		$ks    = hash_hmac( 'sha256', $nonce, self::seal_key(), true );
		$ct    = $move ^ substr( $ks, 0, strlen( $move ) );
		return rtrim( strtr( base64_encode( $nonce . $ct ), '+/', '-_' ), '=' );
	}

	private static function unseal( $sealed ) {
		$raw = base64_decode( strtr( (string) $sealed, '-_', '+/' ) );
		if ( $raw === false || strlen( $raw ) < 9 ) { return ''; }
		$nonce = substr( $raw, 0, 8 ); $ct = substr( $raw, 8 );
		$ks = hash_hmac( 'sha256', $nonce, self::seal_key(), true );
		$mv = $ct ^ substr( $ks, 0, strlen( $ct ) );
		return in_array( $mv, self::TOOLS, true ) ? $mv : '';
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	private static function name_of( $uid ) {
		if ( ! $uid ) { return 'ArtaBot'; }
		$u = get_userdata( (int) $uid );
		return $u ? $u->display_name : 'Member #' . (int) $uid;
	}
	private static function slug_of( $uid ) {
		$u = $uid ? get_userdata( (int) $uid ) : null;
		return $u ? $u->user_nicename : '';
	}
	private static function player_row( $uid ) {
		$t = Data::t( 'aq_rps_players' );
		$r = Data::one( "SELECT * FROM $t WHERE uid = %d", [ (int) $uid ] );
		return $r ?: [ 'uid' => (int) $uid, 'rating' => self::ELO_START, 'wins' => 0, 'losses' => 0, 'draws' => 0, 'games' => 0 ];
	}
	private static function pub_player( $uid ) {
		$r = self::player_row( $uid );
		return [
			'uid' => (int) $uid, 'name' => self::name_of( $uid ), 'slug' => self::slug_of( $uid ),
			'rating' => (int) $r['rating'], 'wins' => (int) $r['wins'], 'losses' => (int) $r['losses'], 'draws' => (int) $r['draws'],
		];
	}
	private static function rounds_of( $row ) {
		$j = json_decode( (string) ( $row['rounds'] ?? '' ), true );
		return is_array( $j ) ? $j : [];
	}

	// ── ArtaBot (chill = uniform over remaining; sharp = predict-and-punish) ─

	private static function bot_move( $rounds, $sharp, $ring = 'wheel' ) {
		$arena = self::arena_tools( $ring );
		$mine = []; $theirs = [];
		foreach ( $rounds as $r ) { $theirs[] = (string) ( $r['a'] ?? '' ); $mine[] = (string) ( $r['b'] ?? '' ); }
		$my_left  = array_values( array_diff( $arena, $mine ) );
		$opp_left = array_values( array_diff( $arena, $theirs ) );
		if ( ! $my_left ) { return $arena[0]; }
		if ( ! $sharp || count( $rounds ) < 2 ) { return $my_left[ random_int( 0, count( $my_left ) - 1 ) ]; }
		// Predict the human's next throw over their REMAINING tools (echo weight on wheel-adjacent
		// to their last throw), then play the remaining tool with the best expected differential.
		$w = array_fill_keys( $opp_left, 1.0 );
		$n = count( $theirs );
		// tools adjacent (on the wheel) to their last throw get a small echo weight — humans drift
		$lastT = $n && $ring === 'wheel' ? $theirs[ $n - 1 ] : null;
		if ( $lastT !== null ) {
			$li = array_search( $lastT, self::TOOLS, true );
			foreach ( [ 1, 11, 2, 10 ] as $off ) {
				$cand = self::TOOLS[ ( $li + $off ) % 12 ];
				if ( isset( $w[ $cand ] ) ) { $w[ $cand ] += 0.6; }
			}
		}
		$best = $my_left[0]; $bs = -INF;
		foreach ( $my_left as $tool ) {
			$e = 0.0;
			foreach ( $w as $their => $wt ) { [ $pa, $pb ] = self::payoff( $tool, $their ); $e += $wt * ( ( $pb === $pa ? 0.4 : 1.0 ) * ( $pa - $pb ) + 0.25 * $pa ); }
			if ( $e > $bs ) { $bs = $e; $best = $tool; }
		}
		return $best;
	}

	// ── Elo ───────────────────────────────────────────────────────────────────

	private static function elo_apply( $uid_a, $uid_b, $score_a ) {  // $score_a: 1 win · 0.5 draw · 0 loss
		$t = Data::t( 'aq_rps_players' );
		$a = self::player_row( $uid_a ); $b = self::player_row( $uid_b );
		$ea = 1.0 / ( 1.0 + pow( 10, ( $b['rating'] - $a['rating'] ) / 400 ) );
		$da = (int) round( self::ELO_K * ( $score_a - $ea ) );
		$db = -$da;
		$now = Data::now();
		foreach ( [ [ $a, $da, $score_a ], [ $b, $db, 1 - $score_a ] ] as [ $row, $d, $s ] ) {
			$vals = [
				'rating' => max( 100, (int) $row['rating'] + $d ),
				'wins'   => (int) $row['wins']   + ( $s === 1 ? 1 : 0 ),
				'losses' => (int) $row['losses'] + ( $s === 0 ? 1 : 0 ),
				'draws'  => (int) $row['draws']  + ( $s === 0.5 ? 1 : 0 ),
				'games'  => (int) $row['games'] + 1,
				'updated' => $now,
			];
			global $wpdb;
			$exists = Data::one( "SELECT uid FROM $t WHERE uid = %d", [ (int) $row['uid'] ] );
			if ( $exists ) { Data::update( 'aq_rps_players', $vals, [ 'uid' => (int) $row['uid'] ] ); }
			else { Data::insert( 'aq_rps_players', array_merge( [ 'uid' => (int) $row['uid'] ], $vals ) ); }
		}
		return [ $da, $db ];
	}

	// ── the clock ─────────────────────────────────────────────────────────────

	/** Bring a live match's clocks current: subtract the elapsed time from whichever bank(s) are
	 *  still "to move" (their throw not yet sealed). A bank hitting 0 flags that player (they lose).
	 *  Idempotent and cheap; safe to call on every read/move. The bot's bank (p2 = 0) never ticks.
	 *  Returns true when a flag ended the match. Mutates + persists $row. */
	private static function charge_clocks( &$row ) {
		if ( $row['status'] !== 'live' ) { return false; }
		$now = Data::now();
		$ts  = (int) ( $row['clock_ts'] ?: $row['last_move'] ?: $now );
		$el  = max( 0, $now - $ts );
		if ( $el <= 0 ) { return false; }
		$flag1 = false; $flag2 = false;
		if ( $row['p1_move'] === '' ) {
			$row['clock1'] = (int) $row['clock1'] - $el;
			if ( $row['clock1'] <= 0 ) { $row['clock1'] = 0; $flag1 = true; }
		}
		if ( $row['p2_move'] === '' && (int) $row['p2'] > 0 ) { // a real opponent; the bot never flags
			$row['clock2'] = (int) $row['clock2'] - $el;
			if ( $row['clock2'] <= 0 ) { $row['clock2'] = 0; $flag2 = true; }
		}
		$row['clock_ts'] = $now;
		$upd = [ 'clock1' => (int) $row['clock1'], 'clock2' => (int) $row['clock2'], 'clock_ts' => $now ];
		if ( $flag1 || $flag2 ) {
			self::finish( $row, $flag1 && $flag2 ? 0 : ( $flag1 ? 2 : 1 ) ); // whoever's bank emptied loses
			$upd = array_merge( $upd, [ 'status' => 'done', 'winner' => (int) $row['winner'],
				'delta1' => (int) $row['delta1'], 'delta2' => (int) $row['delta2'], 'updated' => $now ] );
		}
		Data::update( 'aq_rps_matches', $upd, [ 'id' => (int) $row['id'] ] );
		return $flag1 || $flag2;
	}

	// ── round + match resolution ─────────────────────────────────────────────

	private static function finish( &$row, $winner ) {  // 0 = draw
		$row['status'] = 'done'; $row['winner'] = (int) $winner;
		if ( (int) $row['rated'] === 1 && (int) $row['p2'] > 0 ) {
			$s = $winner === 1 ? 1 : ( $winner === 2 ? 0 : 0.5 );
			[ $d1, $d2 ] = self::elo_apply( (int) $row['p1'], (int) $row['p2'], $s );
			$row['delta1'] = $d1; $row['delta2'] = $d2;
		}
	}

	/** Both moves in → resolve the round with the full-wheel payoff; finish after the 12th. Mutates + persists $row. */
	private static function resolve( &$row ) {
		$a = self::unseal( $row['p1_move'] ); $b = self::unseal( $row['p2_move'] );
		if ( $a === '' || $b === '' ) { return; }
		$rounds = self::rounds_of( $row );
		[ $pa, $pb ] = self::payoff( $a, $b );
		$rounds[] = [ 'r' => count( $rounds ) + 1, 'a' => $a, 'b' => $b, 'pa' => $pa, 'pb' => $pb ];
		$row['p1_score'] = (int) $row['p1_score'] + $pa;
		$row['p2_score'] = (int) $row['p2_score'] + $pb;
		$row['rounds'] = wp_json_encode( $rounds );
		$row['p1_move'] = ''; $row['p2_move'] = '';
		$now = Data::now();
		$row['last_move'] = $now;
		$done = count( $rounds ) >= self::arena_rounds( $row['ring'] );
		if ( $done ) {
			$p1 = (int) $row['p1_score']; $p2 = (int) $row['p2_score'];
			self::finish( $row, $p1 === $p2 ? 0 : ( $p1 > $p2 ? 1 : 2 ) );
		} else {
			// Fischer increment: both banks gain a few seconds each round (covers the reveal), and the
			// clock resets its charge point so the NEXT round's thinking is timed from now.
			$row['clock1']  = (int) $row['clock1'] + self::INCREMENT_S;
			$row['clock2']  = (int) $row['clock2'] + self::INCREMENT_S;
			$row['clock_ts'] = $now;
		}
		Data::update( 'aq_rps_matches', [
			'p1_score' => (int) $row['p1_score'], 'p2_score' => (int) $row['p2_score'],
			'p1_move' => '', 'p2_move' => '', 'rounds' => $row['rounds'],
			'status' => $row['status'], 'winner' => (int) $row['winner'],
			'delta1' => (int) $row['delta1'], 'delta2' => (int) $row['delta2'],
			'clock1' => (int) $row['clock1'], 'clock2' => (int) $row['clock2'], 'clock_ts' => (int) $row['clock_ts'],
			'last_move' => $now, 'updated' => $now,
		], [ 'id' => (int) $row['id'] ] );
	}

	// ── public state (never leaks a pending move) ────────────────────────────

	private static function pub_match( $row, $uid = 0, $chat_after = -1 ) {
		$out = [
			'id' => (int) $row['id'], 'ring' => $row['ring'], 'game' => $row['ring'], 'mode' => $row['mode'], 'status' => $row['status'],
			'rated' => (int) $row['rated'] === 1,
			'p1' => self::pub_player( (int) $row['p1'] ),
			'p2' => (int) $row['p2'] > 0 || $row['mode'] !== 'open' ? self::pub_player( (int) $row['p2'] ) : null,
			'score' => [ (int) $row['p1_score'], (int) $row['p2_score'] ],
			'rounds_total' => self::arena_rounds( $row['ring'] ),
			'rounds' => self::rounds_of( $row ),
			'used' => [ array_values( array_map( fn( $r ) => (string) $r['a'], self::rounds_of( $row ) ) ),
			            array_values( array_map( fn( $r ) => (string) $r['b'], self::rounds_of( $row ) ) ) ],
			'pending' => [ $row['p1_move'] !== '', $row['p2_move'] !== '' ],
			'winner' => (int) $row['winner'], 'delta' => [ (int) $row['delta1'], (int) $row['delta2'] ],
			'you' => (int) $uid === (int) $row['p1'] ? 1 : ( $uid && (int) $uid === (int) $row['p2'] ? 2 : 0 ),
			'last_move' => (int) $row['last_move'], 'created' => (int) $row['created'],
			'idle_claim_s' => self::IDLE_CLAIM_S,
			// the clocks + which seat(s) are currently ticking, and the server clock so the client
			// can count the running bank down smoothly between polls (never a source of truth).
			'clock'     => [ max( 0, (int) $row['clock1'] ), max( 0, (int) $row['clock2'] ) ],
			'clock_s'   => self::CLOCK_S,
			'clock_run' => [ $row['status'] === 'live' && $row['p1_move'] === '',
			                 $row['status'] === 'live' && $row['p2_move'] === '' && (int) $row['p2'] > 0 ],
			'srv_now'   => Data::now(),
		];
		if ( $chat_after >= 0 ) {
			$c = Data::t( 'aq_rps_chat' );
			$msgs = Data::all( "SELECT id, uid, body, created FROM $c WHERE match_id = %d AND id > %d ORDER BY id ASC LIMIT 50",
				[ (int) $row['id'], (int) $chat_after ] );
			$out['chat'] = array_map( fn( $m ) => [
				'id' => (int) $m['id'], 'uid' => (int) $m['uid'], 'name' => self::name_of( (int) $m['uid'] ),
				'body' => (string) $m['body'], 'created' => (int) $m['created'],
			], $msgs );
		}
		return $out;
	}

	// ── routes ────────────────────────────────────────────────────────────────

	/** GET games/rps — one bootstrap: the wheel, leaderboard top, open lobby, the caller's matches. */
	public static function board( $req ) {
		self::ensure_tables();
		$uid = get_current_user_id();
		$m = Data::t( 'aq_rps_matches' ); $p = Data::t( 'aq_rps_players' );
		$now = Data::now();
		// leaderboard: top 25 by rating (players with at least one rated game)
		$top = Data::all( "SELECT uid, rating, wins, losses, draws, games FROM $p WHERE games > 0 ORDER BY rating DESC, uid ASC LIMIT 25" );
		$board = array_map( function ( $r, $i ) {
			return [
				'rank' => $i + 1, 'uid' => (int) $r['uid'], 'name' => self::name_of( (int) $r['uid'] ),
				'slug' => self::slug_of( (int) $r['uid'] ), 'rating' => (int) $r['rating'],
				'wins' => (int) $r['wins'], 'losses' => (int) $r['losses'], 'draws' => (int) $r['draws'],
			];
		}, $top, array_keys( $top ) );
		// open lobby (fresh, not the caller's own)
		$lob = Data::all( "SELECT * FROM $m WHERE status = 'open' AND created > %d ORDER BY id DESC LIMIT 20", [ $now - self::LOBBY_TTL_S ] );
		$lobby = [];
		foreach ( $lob as $r ) { $lobby[] = [ 'id' => (int) $r['id'], 'ring' => $r['ring'], 'game' => $r['ring'], 'by' => self::pub_player( (int) $r['p1'] ), 'created' => (int) $r['created'] ]; }
		$mine = [];
		if ( $uid ) {
			$rows = Data::all( "SELECT * FROM $m WHERE (p1 = %d OR p2 = %d) AND status IN ('open','live') ORDER BY id DESC LIMIT 10", [ $uid, $uid ] );
			foreach ( $rows as $r ) { self::charge_clocks( $r ); $mine[] = self::pub_match( $r, $uid ); }
			$recent = Data::all( "SELECT * FROM $m WHERE (p1 = %d OR p2 = %d) AND status = 'done' ORDER BY id DESC LIMIT 5", [ $uid, $uid ] );
			foreach ( $recent as $r ) { $mine[] = self::pub_match( $r, $uid ); }
		}
		return [
			'tools' => self::TOOLS,
			// the three games as a data-driven catalogue (board tools + round count); copy stays client-side
			'games' => array_map( fn( $g ) => [ 'id' => $g, 'tools' => self::arena_tools( $g ), 'rounds' => self::arena_rounds( $g ) ], self::GAMES ),
			'clock_s' => self::CLOCK_S,
			'leaderboard' => $board, 'lobby' => $lobby, 'mine' => $mine,
			'me' => $uid ? self::pub_player( $uid ) : null,
		];
	}

	/** POST games/rps/match {ring, mode:'open'|'bot-chill'|'bot-sharp'} — create; open-mode auto-pairs with the lobby. */
	public static function create( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_rps_create', 20, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = get_current_user_id();
		$ring = (string) Rest::p( $req, 'game', Rest::p( $req, 'ring', 'wheel' ) ); // 'ring' | 'cross' | 'wheel'
		if ( ! in_array( $ring, self::GAMES, true ) ) { return Rest::err( 'bad_game', 'Unknown game' ); }
		$mode = (string) Rest::p( $req, 'mode', 'open' );
		if ( ! in_array( $mode, [ 'open', 'bot-chill', 'bot-sharp' ], true ) ) { return Rest::err( 'bad_mode', 'Unknown mode' ); }
		$m = Data::t( 'aq_rps_matches' ); $now = Data::now();
		if ( $mode === 'open' ) {
			// matchmaking: join the oldest fresh open challenge by someone else
			$open = Data::one( "SELECT * FROM $m WHERE status = 'open' AND ring = %s AND p1 <> %d AND created > %d ORDER BY id ASC LIMIT 1",
				[ $ring, $uid, $now - self::LOBBY_TTL_S ] );
			if ( $open ) {
				Data::update( 'aq_rps_matches', [ 'p2' => $uid, 'status' => 'live', 'clock_ts' => $now, 'last_move' => $now, 'updated' => $now ], [ 'id' => (int) $open['id'] ] );
				$row = Data::one( "SELECT * FROM $m WHERE id = %d", [ (int) $open['id'] ] );
				return self::pub_match( $row, $uid, 0 );
			}
			// no partner yet — park an open challenge in the lobby (only one per player per game)
			$dup = Data::one( "SELECT id FROM $m WHERE status = 'open' AND ring = %s AND p1 = %d LIMIT 1", [ $ring, $uid ] );
			if ( $dup ) { $row = Data::one( "SELECT * FROM $m WHERE id = %d", [ (int) $dup['id'] ] ); return self::pub_match( $row, $uid, 0 ); }
			$id = Data::insert( 'aq_rps_matches', [
				'ring' => $ring, 'mode' => 'open', 'status' => 'open', 'rated' => 1,
				'p1' => $uid, 'p2' => 0, 'clock1' => self::CLOCK_S, 'clock2' => self::CLOCK_S, 'clock_ts' => 0,
				'rounds' => '[]', 'created' => $now, 'updated' => $now, 'last_move' => $now,
			] );
		} else {
			$id = Data::insert( 'aq_rps_matches', [
				'ring' => $ring, 'mode' => $mode, 'status' => 'live', 'rated' => 0,
				'p1' => $uid, 'p2' => 0, 'clock1' => self::CLOCK_S, 'clock2' => self::CLOCK_S, 'clock_ts' => $now,
				'rounds' => '[]', 'created' => $now, 'updated' => $now, 'last_move' => $now,
			] );
		}
		$row = Data::one( "SELECT * FROM $m WHERE id = %d", [ (int) $id ] );
		return self::pub_match( $row, $uid, 0 );
	}

	/** POST games/rps/match/{id}/join — take up an open challenge. */
	public static function join( $req ) {
		self::ensure_tables();
		$uid = get_current_user_id();
		$id  = Rest::pint( $req, 'id' );
		$m   = Data::t( 'aq_rps_matches' );
		$row = Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Match not found', 404 ); }
		if ( $row['status'] !== 'open' ) { return Rest::err( 'not_open', 'This challenge was already taken', 409 ); }
		if ( (int) $row['p1'] === $uid ) { return Rest::err( 'own_match', 'This is your own challenge' ); }
		$now = Data::now();
		Data::update( 'aq_rps_matches', [ 'p2' => $uid, 'status' => 'live', 'clock_ts' => $now, 'last_move' => $now, 'updated' => $now ], [ 'id' => $id ] );
		$row = Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] );
		return self::pub_match( $row, $uid, 0 );
	}

	/** GET games/rps/match/{id}?chat_after= — the poll: full public state + chat tail. */
	public static function state( $req ) {
		self::ensure_tables();
		$id  = Rest::pint( $req, 'id' );
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_rps_matches' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Match not found', 404 ); }
		self::charge_clocks( $row ); // bring clocks current on every poll (may flag a match on time)
		$after = Rest::pint( $req, 'chat_after', 0 );
		return self::pub_match( $row, get_current_user_id(), $after );
	}

	/** POST games/rps/match/{id}/move {tool} — sealed simultaneous throw; resolves when both are in. */
	public static function move( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_rps_move', 120, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = get_current_user_id();
		$id   = Rest::pint( $req, 'id' );
		$tool = (string) Rest::p( $req, 'tool', '' );
		$m    = Data::t( 'aq_rps_matches' );
		$row  = Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Match not found', 404 ); }
		if ( $row['status'] !== 'live' ) { return Rest::err( 'not_live', 'This match is not live', 409 ); }
		if ( self::charge_clocks( $row ) ) { return self::pub_match( Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] ), $uid, -1 ); } // flagged before the throw landed
		$seat = (int) $row['p1'] === $uid ? 1 : ( (int) $row['p2'] === $uid ? 2 : 0 );
		if ( ! $seat ) { return Rest::err( 'not_player', 'You are not in this match', 403 ); }
		if ( ! in_array( $tool, self::arena_tools( $row['ring'] ), true ) ) { return Rest::err( 'bad_tool', 'Unknown tool' ); }
		$col = $seat === 1 ? 'p1_move' : 'p2_move';
		if ( $row[ $col ] !== '' ) { return Rest::err( 'already_moved', 'You already threw this round', 409 ); }
		foreach ( self::rounds_of( $row ) as $r ) {   // every tool is thrown exactly once
			if ( (string) $r[ $seat === 1 ? 'a' : 'b' ] === $tool ) { return Rest::err( 'spent', 'You already spent that tool this match', 409 ); }
		}
		$row[ $col ] = self::seal( $tool );
		$now = Data::now();
		Data::update( 'aq_rps_matches', [ $col => $row[ $col ], 'last_move' => $now, 'updated' => $now ], [ 'id' => $id ] );
		$row['last_move'] = $now;
		// bot answers instantly (player is always seat 1 in bot matches)
		if ( $row['mode'] !== 'open' && $row['p2_move'] === '' ) {
			$row['p2_move'] = self::seal( self::bot_move( self::rounds_of( $row ), $row['mode'] === 'bot-sharp', $row['ring'] ) );
			Data::update( 'aq_rps_matches', [ 'p2_move' => $row['p2_move'] ], [ 'id' => $id ] );
		}
		if ( $row['p1_move'] !== '' && $row['p2_move'] !== '' ) { self::resolve( $row ); }
		$row = Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] );
		return self::pub_match( $row, $uid, -1 );
	}

	/** POST games/rps/match/{id}/chat {body} — realtime (short-poll) match chat, participants only. */
	public static function chat( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'aq_rps_chat', 30, 60 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }
		$uid  = get_current_user_id();
		$id   = Rest::pint( $req, 'id' );
		$body = trim( sanitize_text_field( (string) Rest::p( $req, 'body', '' ) ) );
		if ( $body === '' || mb_strlen( $body ) > 500 ) { return Rest::err( 'bad_body', 'Say something (≤500 characters)' ); }
		$row = Data::one( 'SELECT id, p1, p2 FROM ' . Data::t( 'aq_rps_matches' ) . ' WHERE id = %d', [ $id ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'Match not found', 404 ); }
		if ( (int) $row['p1'] !== $uid && (int) $row['p2'] !== $uid ) { return Rest::err( 'not_player', 'Only players can chat here', 403 ); }
		$cid = Data::insert( 'aq_rps_chat', [ 'match_id' => $id, 'uid' => $uid, 'body' => $body, 'created' => Data::now() ] );
		return [ 'id' => (int) $cid ];
	}

	/** POST games/rps/match/{id}/claim — the waiting player takes the match after 5 idle minutes. */
	public static function claim( $req ) {
		self::ensure_tables();
		$uid = get_current_user_id();
		$id  = Rest::pint( $req, 'id' );
		$m   = Data::t( 'aq_rps_matches' );
		$row = Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] );
		if ( ! $row || $row['status'] !== 'live' ) { return Rest::err( 'not_live', 'Nothing to claim', 409 ); }
		if ( self::charge_clocks( $row ) ) { return self::pub_match( Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] ), $uid ); } // the clock already decided it
		$seat = (int) $row['p1'] === $uid ? 1 : ( (int) $row['p2'] === $uid ? 2 : 0 );
		if ( ! $seat ) { return Rest::err( 'not_player', 'You are not in this match', 403 ); }
		$mycol = $seat === 1 ? 'p1_move' : 'p2_move';
		if ( $row[ $mycol ] === '' ) { return Rest::err( 'your_turn', 'Throw first — you can only claim while waiting' ); }
		if ( Data::now() - (int) $row['last_move'] < self::IDLE_CLAIM_S ) { return Rest::err( 'too_soon', 'Your opponent still has time' ); }
		self::finish( $row, $seat );
		Data::update( 'aq_rps_matches', [ 'status' => 'done', 'winner' => (int) $row['winner'],
			'delta1' => (int) $row['delta1'], 'delta2' => (int) $row['delta2'], 'updated' => Data::now() ], [ 'id' => $id ] );
		return self::pub_match( Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] ), $uid );
	}

	/** POST games/rps/match/{id}/resign — resign a live match (or withdraw an open challenge). */
	public static function resign( $req ) {
		self::ensure_tables();
		$uid = get_current_user_id();
		$id  = Rest::pint( $req, 'id' );
		$m   = Data::t( 'aq_rps_matches' );
		$row = Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] );
		if ( ! $row || $row['status'] === 'done' ) { return Rest::err( 'not_live', 'Nothing to resign', 409 ); }
		$seat = (int) $row['p1'] === $uid ? 1 : ( (int) $row['p2'] === $uid ? 2 : 0 );
		if ( ! $seat ) { return Rest::err( 'not_player', 'You are not in this match', 403 ); }
		if ( $row['status'] === 'open' ) {
			Data::update( 'aq_rps_matches', [ 'status' => 'done', 'winner' => 0, 'rated' => 0, 'updated' => Data::now() ], [ 'id' => $id ] );
			return [ 'withdrawn' => true ];
		}
		self::finish( $row, $seat === 1 ? 2 : 1 );
		Data::update( 'aq_rps_matches', [ 'status' => 'done', 'winner' => (int) $row['winner'],
			'delta1' => (int) $row['delta1'], 'delta2' => (int) $row['delta2'], 'updated' => Data::now() ], [ 'id' => $id ] );
		return self::pub_match( Data::one( "SELECT * FROM $m WHERE id = %d", [ $id ] ), $uid );
	}

	// ── authored law-line translations (the game ships in 20 languages) ──────
	// Sources are the EXACT English law strings the SPA renders (LAWS_EN); authored targets seed
	// the mesh as status='arta' (final — never downgraded). Everything else on the page
	// auto-translates on demand like any other string.

	private static function seed_i18n() {
		$seed = [
			'zh' => [ "枪打碎杯", "犁吞闪电", "剪刀剪麦", "杯水锈楔子", "闪电熔钩", "麦裹箭", "楔子劈石头", "钩卡锯齿", "箭穿网", "石头砸枪", "锯断犁", "网缠剪刀" ],
			'hi' => [ "बंदूक फोड़े कप", "हल निगले बिजली", "कैंची काटे गेहूं", "कप गलाए पच्चर", "बिजली पिघलाए हुक", "गेहूं थामे तीर", "पच्चर फाड़े पत्थर", "हुक फँसाए आरी", "तीर चीरे जाल", "पत्थर तोड़े बंदूक", "आरी काटे हल", "जाल बाँधे कैंची" ],
			'ar' => [ "المسدس يكسر الكوب", "المحراث يبلع البرق", "المقص يجز القمح", "الكوب يصدئ الإسفين", "البرق يذيب الخطاف", "القمح يحضن السهم", "الإسفين يشق الصخرة", "الخطاف يشل المنشار", "السهم يخرق الشبكة", "الصخرة تسحق المسدس", "المنشار يقطع المحراث", "الشبكة تربط المقص" ],
			'es' => [ "Pistola rompe taza", "Arado traga rayo", "Tijeras siegan trigo", "Taza oxida cuña", "Rayo funde gancho", "Trigo frena flecha", "Cuña parte piedra", "Gancho traba sierra", "Flecha cruza red", "Piedra aplasta pistola", "Sierra corta arado", "Red amarra tijeras" ],
			'jv' => [ "Bedhil mecah cangkir", "Luku nguntal kilat", "Gunting ngethok gandum", "Cangkir mangan paju", "Kilat nglebur pancing", "Gandum nyekel panah", "Paju mbelah watu", "Pancing nyanthol graji", "Panah nrobos jala", "Watu ngremuk bedhil", "Graji nggraji luku", "Jala njiret gunting" ],
			'pt' => [ "Arma racha copo", "Arado engole raio", "Tesoura ceifa trigo", "Copo enferruja cunha", "Raio derrete gancho", "Trigo freia flecha", "Cunha parte pedra", "Gancho trava serra", "Flecha fura rede", "Pedra esmaga arma", "Serra corta arado", "Rede amarra tesoura" ],
			'ha' => [ "Bindiga ta fasa ƙoƙo", "Garma ta haɗiye walƙiya", "Almakashi ya aske alkama", "Ƙoƙo ya ci matoshi", "Walƙiya ta narkar da ƙugiya", "Alkama ta tare kibiya", "Matoshi ya tsaga dutse", "Ƙugiya ta kama zarto", "Kibiya ta ratsa taru", "Dutse ya farfasa bindiga", "Zarto ya yanka garma", "Taru ya daure almakashi" ],
			'pa' => [ "ਬੰਦੂਕ ਤੋੜੇ ਕੱਪ", "ਹਲ ਨਿਗਲੇ ਬਿਜਲੀ", "ਕੈਂਚੀ ਵੱਢੇ ਕਣਕ", "ਕੱਪ ਗਾਲੇ ਫੰਨਾ", "ਬਿਜਲੀ ਪਿਘਲਾਵੇ ਕੁੰਡੀ", "ਕਣਕ ਥੰਮ੍ਹੇ ਤੀਰ", "ਫੰਨਾ ਪਾੜੇ ਪੱਥਰ", "ਕੁੰਡੀ ਅੜਾਵੇ ਆਰੀ", "ਤੀਰ ਚੀਰੇ ਜਾਲ", "ਪੱਥਰ ਭੰਨੇ ਬੰਦੂਕ", "ਆਰੀ ਵੱਢੇ ਹਲ", "ਜਾਲ ਬੰਨ੍ਹੇ ਕੈਂਚੀ" ],
			'bn' => [ "বন্দুক ফাটায় কাপ", "লাঙল গিলে বাজ", "কাঁচি কাটে গম", "কাপ খায় গোঁজ", "বাজ গলায় হুক", "গম থামায় তীর", "গোঁজ চেরে পাথর", "হুক আটকায় করাত", "তীর ফুঁড়ে জাল", "পাথর ভাঙে বন্দুক", "করাত কাটে লাঙল", "জাল বাঁধে কাঁচি" ],
			'ru' => [ "Ружьё бьёт чашку", "Плуг гасит молнию", "Ножницы стригут пшеницу", "Чашка ржавит клин", "Молния плавит крюк", "Пшеница глушит стрелу", "Клин колет камень", "Крюк клинит пилу", "Стрела пронзает сеть", "Камень крушит ружьё", "Пила пилит плуг", "Сеть вяжет ножницы" ],
			'fa' => [ "تفنگ فنجان را می‌شکند", "خیش برق را خاک می‌کند", "قیچی گندم را می‌چیند", "فنجان گوه را می‌پوساند", "برق قلاب را آب می‌کند", "گندم تیر را نرم می‌گیرد", "گوه سنگ را می‌شکافد", "قلاب اره را قفل می‌کند", "تیر از تور می‌گذرد", "سنگ تفنگ را خرد می‌کند", "اره خیش را می‌بُرد", "تور قیچی را می‌بندد" ],
			'ja' => [ "銃はコップを割る", "鋤は雷を呑む", "はさみは麦を刈る", "コップはくさびを錆びさす", "雷は鉤を溶かす", "麦は矢をそっと止める", "くさびは石を割る", "鉤はのこぎりを噛む", "矢は網を抜ける", "石は銃を砕く", "のこぎりは鋤を挽く", "網ははさみを縛る" ],
			'vi' => [ "Súng bắn vỡ cốc", "Cày chôn sét", "Kéo cắt lúa mì", "Cốc làm nêm gỉ", "Sét nung chảy móc", "Lúa mì nuốt tên", "Nêm chẻ đá", "Móc khóa răng cưa", "Tên xuyên lưới", "Đá đập nát súng", "Cưa xẻ cày", "Lưới trói kéo" ],
			'de' => [ "Gewehr knackt Tasse", "Pflug erdet Blitz", "Schere schert Weizen", "Tasse zerfrisst Keil", "Blitz schmilzt Haken", "Weizen schluckt Pfeil", "Keil spaltet Stein", "Haken klemmt Säge", "Pfeil durchschießt Netz", "Stein zerschmettert Gewehr", "Säge sägt Pflug", "Netz fesselt Schere" ],
			'tr' => [ "Silah fincanı kırar", "Saban şimşeği gömer", "Makas buğdayı biçer", "Fincan kamayı paslandırır", "Şimşek kancayı eritir", "Buğday oku yutar", "Kama taşı yarar", "Kanca testereyi kilitler", "Ok ağı deler", "Taş silahı ezer", "Testere sabanı keser", "Ağ makası bağlar" ],
			'fr' => [ "Le fusil casse la tasse", "La charrue enterre la foudre", "Les ciseaux fauchent le blé", "La tasse rouille le coin", "La foudre fond le crochet", "Le blé étouffe la flèche", "Le coin fend la pierre", "Le crochet coince la scie", "La flèche perce le filet", "La pierre brise le fusil", "La scie scie la charrue", "Le filet ficelle les ciseaux" ],
			'ko' => [ "총은 컵을 깬다", "쟁기는 번개를 삼킨다", "가위는 밀을 벤다", "컵은 쐐기를 좀먹는다", "번개는 갈고리를 녹인다", "밀은 화살을 품는다", "쐐기는 돌을 쪼갠다", "갈고리는 톱니를 문다", "화살은 그물을 뚫는다", "돌은 총을 부순다", "톱은 쟁기를 자른다", "그물은 가위를 묶는다" ],
			'zu' => [ "Isibhamu siphula inkomishi", "Igeja ligqiba umbani", "Isikelo sigunda ukolweni", "Inkomishi igqwalisa isikhonkwane", "Umbani uncibilikisa udobo", "Ukolweni ubamba umcibisholo", "Isikhonkwane sicanda itshe", "Udobo luvimba isaha", "Umcibisholo ubhoboza inethi", "Itshe lichoboza isibhamu", "Isaha lisaha igeja", "Inethi ibopha isikelo" ],
			'it' => [ "La pistola spacca la tazza", "L'aratro interra il fulmine", "Le forbici tosano il grano", "La tazza arrugginisce la zeppa", "Il fulmine fonde il gancio", "Il grano smorza la freccia", "La zeppa fende il sasso", "Il gancio inceppa la sega", "La freccia buca la rete", "Il sasso sfascia la pistola", "La sega sega l'aratro", "La rete lega le forbici" ],
		];
		global $wpdb;
		$t = Data::t( 'aq_translations' );
		foreach ( $seed as $lang => $lines ) {
			foreach ( $lines as $k => $target ) {
				$src  = self::LAWS_EN[ $k ];
				$hash = md5( $src );
				$have = Data::one( "SELECT id, status FROM $t WHERE source_hash = %s AND lang = %s", [ $hash, $lang ] );
				if ( $have && $have['status'] === 'arta' ) { continue; }                       // never touch an existing arta row
				if ( $have ) {
					$wpdb->update( $t, [ 'translated_text' => $target, 'status' => 'arta', 'quality' => 100,
						'updated_at' => current_time( 'mysql' ) ], [ 'id' => (int) $have['id'] ] );
				} else {
					$wpdb->insert( $t, [
						'source_hash' => $hash, 'lang' => $lang, 'source_text' => $src,
						'translated_text' => $target, 'context' => 'content', 'status' => 'arta',
						'quality' => 100, 'priority' => 0, 'updated_at' => current_time( 'mysql' ),
					] );
				}
			}
		}
	}
}
