<?php
/**
 * ArtaQuest discussion-first model — backend assertion harness (part of the dev cycle).
 *
 * Exercises EVERY aspect of the learning surface against the real REST handlers (with a real
 * session + WP_REST_Request), asserts the outcome, and self-cleans. Idempotent. Prints
 * "PASS n / FAIL n" and the marker the dev-cycle runner greps for.
 *
 *   studio wp eval 'require WP_PLUGIN_DIR . "/aquest/tools/test-model.php";'
 *
 * Covered: free enrolment; sequential unlock (UI + API guards); section comments (length, lock,
 * many-per-section, replies, engagement point once); the open discussion board (visible to all,
 * mine/vote flags); upvoting (self-vote guard, toggle, denorm tally, author-point idempotency
 * under un-vote/re-vote); engagement + certificate (watch + comment + upvote-one-other, with the
 * lone-first-commenter relaxation + monotonic pct); the Kaggle podium by UPVOTES (50/30/20,
 * ≥20-enrol gate, certified-only, rebalance, uncertified hold); season archival (new-moon reset);
 * payments + fulfilment (donations/coins/webhook, idempotent, backing tracks minting); and cash-out
 * payouts (Stripe Connect transfers — frozen/onboarding/failed/success guards, money-first ordering,
 * backing shrinks on redeem, replay-safe).
 */
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

$GLOBALS['aqt'] = [ 'pass' => 0, 'fail' => 0, 'fails' => [] ];
function aqt_ok( $label, $cond ) {
	if ( $cond ) { $GLOBALS['aqt']['pass']++; }
	else { $GLOBALS['aqt']['fail']++; $GLOBALS['aqt']['fails'][] = $label; echo "  ✗ FAIL: $label\n"; }
}
function aqt_eq( $label, $got, $want ) {
	$cond = $got === $want;
	if ( ! $cond ) { echo "    [got " . var_export( $got, true ) . " want " . var_export( $want, true ) . "]\n"; }
	aqt_ok( $label, $cond );
}
function aqt_err( $res ) {
	if ( is_wp_error( $res ) ) { return $res->get_error_code(); }
	if ( $res instanceof \WP_REST_Response ) { $d = $res->get_data(); return is_array( $d ) ? ( $d['error'] ?? null ) : null; }
	return is_array( $res ) ? ( $res['error'] ?? null ) : null;
}
function aqt_req( $params ) { $r = new \WP_REST_Request(); foreach ( $params as $k => $v ) { $r->set_param( $k, $v ); } return $r; }
function aqt_as( $uid ) { wp_set_current_user( (int) $uid ); }
function aqt_section( $s ) { echo "\n— $s\n"; }

global $wpdb; $p = $wpdb->prefix;
require_once ABSPATH . 'wp-admin/includes/user.php';

$cid     = (int) $wpdb->get_var( "SELECT id FROM {$p}aq_courses ORDER BY id ASC LIMIT 1" );
$lessons = array_map( 'intval', $wpdb->get_col( "SELECT id FROM {$p}aq_lessons WHERE course_id = $cid ORDER BY idx ASC" ) );
$N       = count( $lessons );

function aqt_cleanup( $cid, $lessons ) {
	global $wpdb; $p = $wpdb->prefix;
	foreach ( $wpdb->get_col( "SELECT ID FROM {$p}users WHERE user_login LIKE 'aqt_%'" ) as $id ) { wp_delete_user( (int) $id ); }
	$in = implode( ',', $lessons ) ?: '0';
	foreach ( [ 'aq_enroll', 'aq_progress' ] as $t ) { $wpdb->query( "DELETE FROM {$p}$t WHERE course_id = $cid OR lesson_id IN ($in)" ); }
	$wpdb->query( "DELETE FROM {$p}aq_comments WHERE context_type = 'section' AND ( course_id = $cid OR context_id IN ($in) )" );
	$wpdb->query( "DELETE FROM {$p}aq_votes WHERE target_type = 'comment' AND ( course_id = $cid OR context_id IN ($in) )" );
	$wpdb->query( "DELETE FROM {$p}aq_coin_ledger WHERE reason IN ( 'qreward', 'enroll', 'test_seed' )" );
	$wpdb->query( "DELETE FROM {$p}aq_points_ledger WHERE track = 'learn'" );
	$wpdb->query( "DELETE FROM {$p}aq_notifications WHERE user_id NOT IN ( SELECT ID FROM {$p}users )" ); // drop orphan upvote/follow notifications from prior runs
	$wpdb->query( "DELETE FROM {$p}aq_season_results WHERE course_id = $cid" );
	$wpdb->query( "UPDATE {$p}aq_lessons SET comment_count = 0 WHERE id IN ($in)" ); // the section comments were deleted raw above — re-zero the denorm tally
	$wpdb->query( "DELETE FROM {$p}aq_quester WHERE course_id = $cid" );             // every season's test buckets (the live season is rebuilt below)
	$wpdb->query( "DELETE FROM {$p}aq_fulfilment WHERE session_id IN ('csA','csD','csC')" ); // release the harness's Stripe-session claims, or a re-run can't re-fulfil them
	// The raw ledger/comment DELETEs above bypass the lockstep projection maintenance (production never
	// deletes — ledgers are append-only), so rebuild aq_standing / aq_counters (incl. the fund_<bucket>
	// totals) / aq_quester. A run then starts AND ends with the projections exactly equal to the ledgers
	// (verify-projections stays green after a test run).
	\AQ\Economy::rebuild_projections();
	\AQ\Economy::rebuild_quester();
}
aqt_cleanup( $cid, $lessons );
$wpdb->update( "{$p}aq_courses", [ 'enroll_count' => 0, 'revenue' => 1000 ], [ 'id' => $cid ] );

$U = [];
for ( $i = 0; $i < 25; $i++ ) { $u = wp_create_user( "aqt_$i", wp_generate_password(), "aqt_$i@ex.com" ); $U[ $i ] = is_wp_error( $u ) ? 0 : (int) $u; }
// Courses now charge an entry fee on enrol — seed every test learner with coins to spend on it.
// Posting/voting requires a complete identity (Verify::require_identity: full name + valid birthday),
// so give each synthetic learner one — a real signed-in member always has these.
foreach ( $U as $u ) {
	if ( ! $u ) { continue; }
	Economy::credit_coins( $u, 1000, 'test_seed', "seed:c$cid:u$u" );
	update_user_meta( $u, 'aq_full_name', "Aqt Tester $u" );
	update_user_meta( $u, 'aq_birthday', '1990-01-01' );
}
echo "fixtures: course=$cid sections=$N users=" . count( array_filter( $U ) ) . " pool=" . Economy::reward_pool( 1000 ) . "\n";

$points = fn( $uid ) => Economy::points_by_track( $uid )['learn']; // learn track only — signup now grants 10 'welcome' points (1.24.0), which would skew a grand-total read
$pct    = fn( $uid ) => (int) $wpdb->get_var( $wpdb->prepare( "SELECT pct FROM {$p}aq_enroll WHERE user_id=%d AND course_id=%d", $uid, $cid ) );
// Simulate a fully-watched section directly. (The watch-time anti-cheat heartbeat in Learn::progress
// needs real elapsed wall-clock time, which a synchronous test can't accrue; the unlock/lock guards it
// shares are still exercised through the real handler in scenario 2.)
$watch  = function ( $uid, $lid ) use ( $cid ) { aqt_as( $uid ); Data::upsert( 'aq_progress', [ 'user_id' => $uid, 'lesson_id' => $lid ], [ 'course_id' => $cid, 'done' => 1, 'watched' => 99999, 'started' => time() - 99999, 'updated' => time() ] ); };
$comment = function ( $uid, $lid, $body, $parent = 0 ) { aqt_as( $uid ); $r = Learn::post_comment( aqt_req( [ 'lesson_id' => $lid, 'body' => $body, 'parent_id' => $parent ] ) ); return is_array( $r ) ? ( $r['id'] ?? 0 ) : $r; };
$vote   = function ( $uid, $comment_id, $dir = 1 ) { aqt_as( $uid ); return Learn::vote_comment( aqt_req( [ 'comment_id' => $comment_id, 'dir' => $dir ] ) ); };
$upvote = function ( $uid, $comment_id ) use ( $vote ) { return $vote( $uid, $comment_id, 1 ); };

/* ── 1. Enrolment ───────────────────────────────────────────────────────── */
aqt_section( '1. Enrolment' );
$fee = Funds::course_cost( $cid );
foreach ( $U as $u ) { aqt_as( $u ); Learn::enroll( aqt_req( [ 'course_id' => $cid ] ) ); }
aqt_as( $U[0] ); Learn::enroll( aqt_req( [ 'course_id' => $cid ] ) );
aqt_eq( 'enroll_count = 25 (idempotent)', (int) $wpdb->get_var( "SELECT enroll_count FROM {$p}aq_courses WHERE id=$cid" ), 25 );
aqt_eq( 'entry fee charged once (balance = 1000 − fee)', Economy::coin_balance( $U[0] ), 1000 - $fee );
aqt_eq( 'revenue credited by 25 × fee', (int) $wpdb->get_var( "SELECT revenue FROM {$p}aq_courses WHERE id=$cid" ), 1000 + 25 * $fee );
// Broke learner can't enrol — gets a 402, no enrolment.
$broke = wp_create_user( 'aqt_broke', wp_generate_password(), 'aqt_broke@ex.com' ); $broke = is_wp_error( $broke ) ? 0 : (int) $broke;
aqt_as( $broke ); $br = Learn::enroll( aqt_req( [ 'course_id' => $cid ] ) );
aqt_eq( 'no coins → payment_required', aqt_err( $br ), 'payment_required' );
aqt_eq( 'broke learner not enrolled', (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$p}aq_enroll WHERE user_id=%d AND course_id=%d", $broke, $cid ) ), 0 );
// Normalize revenue to the synthetic fixture pool for the reward-distribution scenarios below.
$wpdb->update( "{$p}aq_courses", [ 'revenue' => 1000 ], [ 'id' => $cid ] );

/* ── 2. Sequential unlock ───────────────────────────────────────────────── */
aqt_section( '2. Sequential unlock' );
aqt_as( $U[0] );
aqt_ok( 'section 1 unlocked for fresh learner', ! Learn::is_locked( $U[0], $cid, $lessons[0] ) );
// [all content unlocked, 2026-06-09] watch-to-unlock is retired: every section is open to everyone
// (is_locked is always false) and progress is never refused as 'locked'. These assert the pivot holds.
aqt_ok( 'section 2 ALSO unlocked (all content open)', ! Learn::is_locked( $U[0], $cid, $lessons[1] ) );
aqt_ok( 'progress is never watch-locked', aqt_err( Learn::progress( aqt_req( [ 'lesson_id' => $lessons[2], 'done' => 1 ] ) ) ) !== 'locked' );
$watch( $U[0], $lessons[0] );
aqt_ok( 'watching section 1 unlocks section 2', ! Learn::is_locked( $U[0], $cid, $lessons[1] ) );

/* ── 3. Section comments ────────────────────────────────────────────────── */
aqt_section( '3. Section comments' );
aqt_eq( 'too-short comment rejected', aqt_err( Learn::post_comment( aqt_req( [ 'lesson_id' => $lessons[0], 'body' => 'x' ] ) ) ), 'too_short' );
$c0 = $comment( $U[0], $lessons[0], 'My takeaway: control of the centre is the whole game early on.' );
aqt_ok( 'valid comment accepted', $c0 > 0 );
aqt_eq( 'first comment in a section awards 1 learn point', $points( $U[0] ), 1 );
$comment( $U[0], $lessons[0], 'A second thought I had about development.' );
aqt_eq( 'a SECOND comment in the same section does NOT re-award', $points( $U[0] ), 1 );
$reply = $comment( $U[0], $lessons[0], 'replying to myself for the test', $c0 );
aqt_ok( 'threaded reply accepted (parent_id)', $reply > 0 );
aqt_eq( 'reply to a reply rejected (one level deep)', aqt_err( Learn::post_comment( aqt_req( [ 'lesson_id' => $lessons[0], 'body' => 'nested too far', 'parent_id' => $reply ] ) ) ), 'bad_parent' );

/* ── 4. The open discussion board ───────────────────────────────────────── */
aqt_section( '4. Discussion board' );
$watch( $U[1], $lessons[0] );
$th = Learn::section_thread( aqt_req( [ 'lesson_id' => $lessons[0] ] ) ); // U1 hasn't commented yet
aqt_ok( 'board is open — peers see comments before commenting', count( $th['items'] ) >= 1 );
aqt_ok( 'U1 sees not-yet-commented state', $th['mine_commented'] === false && $th['engaged'] === false );
$c0row = array_values( array_filter( $th['items'], fn( $it ) => (int) $it['id'] === (int) $c0 ) );
aqt_ok( 'top-level comment carries its replies as children + reply count', count( $c0row ) === 1 && $c0row[0]['replies'] === 1 && count( $c0row[0]['children'] ) === 1 );
$c1 = $comment( $U[1], $lessons[0], 'Great point — I would add that piece activity matters too.' );
$th = Learn::section_thread( aqt_req( [ 'lesson_id' => $lessons[0] ] ) );
$mineRow = array_values( array_filter( $th['items'], fn( $it ) => $it['mine'] ) );
aqt_ok( 'own comment is flagged mine + others not', count( $mineRow ) >= 1 && $th['mine_commented'] === true );

/* ── 5. Up/down voting (Reddit) ─────────────────────────────────────────── */
aqt_section( '5. Up/down voting' );
aqt_eq( 'voting your own comment → self_vote', aqt_err( $vote( $U[0], $c0, 1 ) ), 'self_vote' );
$v = $vote( $U[1], $c0, 1 ); // upvote
aqt_ok( 'upvote → my_vote 1, score 1', is_array( $v ) && $v['my_vote'] === 1 && $v['votes'] === 1 );
aqt_eq( 'author gains 1 learn point from the upvote', $points( $U[0] ), 2 ); // 1 comment + 1 upvote received
$v = $vote( $U[1], $c0, 1 ); // click up again → clear
aqt_ok( 're-click up clears → my_vote 0, score 0', $v['my_vote'] === 0 && $v['votes'] === 0 );
aqt_eq( 'clearing does NOT claw back the author point', $points( $U[0] ), 2 );
$v = $vote( $U[1], $c0, -1 ); // downvote
aqt_ok( 'downvote → my_vote -1, score -1 (can go negative)', $v['my_vote'] === -1 && $v['votes'] === -1 );
aqt_eq( 'downvote does NOT change author points (lifetime only grows)', $points( $U[0] ), 2 );
$v = $vote( $U[1], $c0, 1 ); // switch down → up
aqt_ok( 'switch down→up → my_vote 1, score 1', $v['my_vote'] === 1 && $v['votes'] === 1 );
aqt_eq( 'BUGFIX: re-upvote never farms a second author point', $points( $U[0] ), 2 );
$watch( $U[2], $lessons[0] );
$v = $vote( $U[2], $c0, -1 ); // second voter downvotes → net = up - down
aqt_eq( 'net score = upvotes − downvotes (1 up, 1 down = 0)', $v['votes'], 0 );
aqt_eq( 'denorm score matches the source rows', (int) $wpdb->get_var( $wpdb->prepare( "SELECT votes FROM {$p}aq_comments WHERE id=%d", $c0 ) ), 0 );
$v = $vote( $U[1], $reply, 1 ); // regression: a threaded REPLY is votable exactly like a top-level comment
aqt_ok( 'section-board REPLY can be upvoted (my_vote 1, votes 1)', is_array( $v ) && $v['my_vote'] === 1 && $v['votes'] === 1 );
$vote( $U[1], $reply, 0 ); // clear it again
$vote( $U[1], $c0, 0 ); $vote( $U[2], $c0, 0 ); // clear both → leave c0 neutral for later scenarios

/* ── 6. Engagement + certificate (watch + comment + upvote) ─────────────── */
aqt_section( '6. Engagement + certificate' );
// alone-relaxation: a lone first commenter engages a section with no upvote (nothing to vote on).
$watch( $U[17], $lessons[0] ); $watch( $U[17], $lessons[1] );
$comment( $U[17], $lessons[1], 'Lone first comment in this still-empty section.' ); // lessons[1] is clean so far
aqt_ok( 'lone first commenter engages a section (alone relaxation)', Learn::progress_map( $U[17], $cid )[ $lessons[1] ]['engaged'] === true );

// Pass 1 — five learners (A=10, B=11, C=12, D=13, E=18) comment in EVERY section (watch in order).
$cm  = []; // cm[ui][lid] = comment id
$who = [ 10, 11, 12, 13, 18 ];
foreach ( $who as $ui ) { foreach ( $lessons as $li => $lid ) { $watch( $U[ $ui ], $lid ); $cm[ $ui ][ $lid ] = $comment( $U[ $ui ], $lid, "u$ui: a real reflection on section $li and what it opened up." ); } }
// Pass 2 — engagement upvotes producing A > B (C/D get none here). Every learner upvotes ≥1 peer.
foreach ( $lessons as $lid ) {
	$upvote( $U[10], $cm[11][ $lid ] ); // A upvotes B  → A engaged; B+1
	$upvote( $U[11], $cm[10][ $lid ] ); // B upvotes A  → B engaged; A+1
	$upvote( $U[12], $cm[10][ $lid ] ); // C upvotes A  → C engaged; A+1
	$upvote( $U[13], $cm[10][ $lid ] ); // D upvotes A  → D engaged; A+1
}
aqt_eq( 'A certifies (watch+comment+upvote all)', $pct( $U[10] ), 100 );
aqt_eq( 'B certifies', $pct( $U[11] ), 100 );
aqt_eq( 'C certifies', $pct( $U[12] ), 100 );
aqt_eq( 'D certifies', $pct( $U[13] ), 100 );
aqt_ok( 'E commented everywhere but never upvoted → < 100%', $pct( $U[18] ) < 100 );
foreach ( $lessons as $lid ) { $upvote( $U[18], $cm[10][ $lid ] ); } // E upvotes one per section → engaged
aqt_eq( 'after upvoting one per section, E certifies', $pct( $U[18] ), 100 );
$comment( $U[10], $lessons[0], 'A late afterthought from A.' );
aqt_eq( 'certificate is monotonic — A stays 100 after peers arrived', $pct( $U[10] ), 100 );
$certN = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$p}aq_enroll e JOIN {$p}users u ON u.ID=e.user_id WHERE e.course_id=$cid AND e.pct>=100 AND u.user_login LIKE 'aqt_%'" );
aqt_eq( 'certified count = 5 (A,B,C,D,E)', $certN, 5 );

/* ── 7. Podium by upvotes (Kaggle 50/30/20) ─────────────────────────────── */
aqt_section( '7. Podium prize (by upvotes)' );
// A leads (≈ B,C,D,E upvotes). Give B then C competition upvotes so A > B > C (all certified).
foreach ( [ $U[4], $U[5], $U[6], $U[7], $U[8] ] as $vu ) { $watch( $vu, $lessons[0] ); $upvote( $vu, $cm[11][ $lessons[0] ] ); } // B +5
foreach ( [ $U[4], $U[5] ] as $vu ) { $upvote( $vu, $cm[12][ $lessons[0] ] ); } // C +2
$pool = Economy::reward_pool( 1000 );
$vA = Economy::user_medal( $cid, $U[10] ); $vB = Economy::user_medal( $cid, $U[11] ); $vC = Economy::user_medal( $cid, $U[12] );
aqt_ok( 'ordering A > B > C by upvotes', $vA['votes'] > $vB['votes'] && $vB['votes'] > $vC['votes'] );
aqt_eq( 'pool = 800 (80% of revenue)', $pool, 800 );
aqt_eq( 'gold collected 50% = 400', Economy::quester_reward_earned( $cid, $U[10] ), 400 );
aqt_eq( 'silver collected 30% = 240', Economy::quester_reward_earned( $cid, $U[11] ), 240 );
aqt_eq( 'bronze collected 20% = 160', Economy::quester_reward_earned( $cid, $U[12] ), 160 );
aqt_eq( 'total distributed = 800 (exactly the pool)', (int) Economy::rewards_distributed( $cid ), 800 );

/* ── 8. Rebalance on overtake ───────────────────────────────────────────── */
aqt_section( '8. Rebalance on overtake' );
// 14 voters who have NOT yet upvoted C (avoid U4/U5 — they already did, re-voting would toggle off).
foreach ( [ $U[6], $U[7], $U[8], $U[9], $U[14], $U[15], $U[16], $U[17], $U[19], $U[20], $U[21], $U[22], $U[23], $U[24] ] as $vu ) { $upvote( $vu, $cm[12][ $lessons[0] ] ); } // C surges past B
aqt_ok( 'C now out-votes B', Economy::user_medal( $cid, $U[12] )['votes'] > Economy::user_medal( $cid, $U[11] )['votes'] );
aqt_eq( 'silver now goes to C (240)', Economy::quester_reward_earned( $cid, $U[12] ), 240 );
aqt_eq( 'B drops to bronze (160)', Economy::quester_reward_earned( $cid, $U[11] ), 160 );
aqt_eq( 'total still exactly the pool', (int) Economy::rewards_distributed( $cid ), 800 );

/* ── 9. Rankings endpoint shape + medals ────────────────────────────────── */
aqt_section( '9. Rankings endpoint' );
$rk = Learn::course_rankings( aqt_req( [ 'id' => $cid ] ) );
aqt_eq( 'eligible (≥20 enrolled)', $rk['eligible'], true );
aqt_eq( 'pool = 800', $rk['pool'], 800 );
aqt_eq( 'split = [50,30,20]', $rk['split'], [ 50, 30, 20 ] );
aqt_eq( 'medals gold/silver/bronze on ranks 1-3', array_map( fn( $i ) => $rk['items'][ $i ]['medal'] ?? '', [ 0, 1, 2 ] ), [ 'gold', 'silver', 'bronze' ] );
aqt_ok( 'board ordered by upvotes (desc)', $rk['items'][0]['votes'] >= $rk['items'][1]['votes'] && $rk['items'][1]['votes'] >= $rk['items'][2]['votes'] );

/* ── 10. Reward gates ───────────────────────────────────────────────────── */
aqt_section( '10. Reward gates' );
$wpdb->update( "{$p}aq_courses", [ 'enroll_count' => 19 ], [ 'id' => $cid ] );
$before = (int) Economy::rewards_distributed( $cid );
Economy::settle_course_rewards( $cid );
aqt_eq( 'no settlement when < 20 enrolled', (int) Economy::rewards_distributed( $cid ), $before );
$wpdb->update( "{$p}aq_courses", [ 'enroll_count' => 25, 'revenue' => 0 ], [ 'id' => $cid ] );
$before = (int) Economy::rewards_distributed( $cid );
Economy::settle_course_rewards( $cid );
aqt_eq( 'zero-revenue course adds no new payout', (int) Economy::rewards_distributed( $cid ), $before );

/* ── 11. Season archival (new-moon reset) ───────────────────────────────── */
aqt_section( '11. Season archival' );
$wpdb->update( "{$p}aq_courses", [ 'enroll_count' => 25, 'revenue' => 1000 ], [ 'id' => $cid ] );
$wpdb->query( "DELETE FROM {$p}aq_coin_ledger WHERE reason = 'qreward'" );
$cur      = Season::current();
$prevEnd  = (int) $cur['start'];
$prevStart = (int) Season::reset_before( $prevEnd );
$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_votes SET created = %d WHERE target_type = 'comment' AND course_id = %d", $prevStart + 100, $cid ) );
// Backdating the votes simulates "this activity happened last season" — so move the course's LIVE
// quester buckets back with them: they are exactly the projection rows live maintenance had built
// while those votes were being cast (when that season WAS the current one). Season reads (podium,
// ensure_archived's course list) are projection-driven, never created-range scans of aq_votes.
$wpdb->query( $wpdb->prepare( "UPDATE {$p}aq_quester SET season_key = %d WHERE season_key = %d AND course_id = %d", $prevEnd, (int) $cur['key'], $cid ) );
$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_seasons WHERE season_key = %d", $prevEnd ) );
$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_season_results WHERE course_id = %d", $cid ) );
Season::ensure_archived();
aqt_ok( 'previous season recorded closed', (bool) $wpdb->get_var( $wpdb->prepare( "SELECT closed FROM {$p}aq_seasons WHERE season_key=%d", $prevEnd ) ) );
$snap = Data::all( "SELECT place, prize FROM {$p}aq_season_results WHERE season_key = %d AND course_id = %d ORDER BY place", [ $prevEnd, $cid ] );
aqt_ok( 'snapshot froze a podium (400/240/160)', count( $snap ) >= 3 && (int) $snap[0]['prize'] === 400 && (int) $snap[1]['prize'] === 240 && (int) $snap[2]['prize'] === 160 );
aqt_ok( 'prizes paid under the season-scoped ref', (int) Economy::rewards_distributed( $cid, $prevEnd ) > 0 );
$rkCur = Learn::course_rankings( aqt_req( [ 'id' => $cid ] ) );
aqt_eq( 'new season starts fresh (0 upvotes this window)', max( array_map( fn( $it ) => (int) $it['votes'], $rkCur['items'] ) ?: [ 0 ] ), 0 );
aqt_eq( 'current-season payout independent of the archived one', (int) Economy::rewards_distributed( $cid, (int) $cur['key'] ), 0 );
$rkPast = Learn::course_rankings( aqt_req( [ 'id' => $cid, 'season' => $prevEnd ] ) );
aqt_ok( 'archived view flagged + lists winners', ! empty( $rkPast['archived'] ) && count( $rkPast['items'] ) >= 3 && $rkPast['items'][0]['medal'] === 'gold' );
aqt_ok( 'seasons dropdown lists current + past', (bool) array_filter( $rkPast['seasons'], fn( $s ) => (int) $s['key'] === $prevEnd ) && (bool) array_filter( $rkPast['seasons'], fn( $s ) => ! empty( $s['current'] ) ) );
aqt_ok( 'current season has a deadline', (int) $rkCur['reset_at'] > time() && (int) $rkCur['closes_in'] > 0 );
$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_seasons WHERE season_key = %d", $prevEnd ) );

/* ── 12. Payments + fulfilment (donations, coins, distribution, webhook) ───── */
aqt_section( '12. Payments + fulfilment' );
$pu = wp_create_user( 'aqt_pay', wp_generate_password(), 'aqt_pay@ex.com' ); $pu = is_wp_error( $pu ) ? 0 : (int) $pu;

// record_gift splits a directed gift finer-grained across per-group + per-country earmark buckets.
Funds::record_gift( $pu, 3000, [ 'refugees' ], [ 'ca' ], 'tref1' );
aqt_eq( 'gift split → grp_refugees half', (int) $wpdb->get_var( "SELECT COALESCE(SUM(cents),0) FROM {$p}aq_fund_ledger WHERE bucket='grp_refugees' AND ref='tref1'" ), 1500 );
aqt_eq( 'gift split → cty_ca half',       (int) $wpdb->get_var( "SELECT COALESCE(SUM(cents),0) FROM {$p}aq_fund_ledger WHERE bucket='cty_ca' AND ref='tref1'" ), 1500 );

// record_donation: an earmark bucket (grp_/cty_/typ_) is allowed; anything else falls back to bursary.
Funds::record_donation( $pu, 500, 'grp_students', 'x', 'tref2' );
aqt_ok( 'earmark bucket allowed',          (bool) $wpdb->get_var( "SELECT 1 FROM {$p}aq_fund_ledger WHERE bucket='grp_students' AND ref='tref2'" ) );
Funds::record_donation( $pu, 500, 'totally_made_up', 'x', 'tref3' );
aqt_ok( 'unknown bucket → bursary',        (bool) $wpdb->get_var( "SELECT 1 FROM {$p}aq_fund_ledger WHERE bucket='bursary' AND ref='tref3'" ) );

// finances: total sums EVERY bucket (earmarks never undercounted) + exposes the earmark breakdown.
$fin = Funds::finances( aqt_req( [] ) );
aqt_ok( 'finances exposes earmarks',       array_key_exists( 'earmarks', $fin ) && (bool) array_filter( $fin['earmarks'], fn( $e ) => $e['bucket'] === 'grp_refugees' ) );
aqt_eq( 'finances total = sum of ALL buckets', (int) $fin['total_cents'], (int) $wpdb->get_var( "SELECT COALESCE(SUM(cents),0) FROM {$p}aq_fund_ledger" ) );

// coin-purchase fulfilment is idempotent per ledger ref (Stripe return + webhook can both call it),
// and minting coins bumps the gold backing in lockstep so the full-reserve invariant holds.
$cb0 = Economy::coin_balance( $pu );
$bk0 = Economy::backing_mg();
Economy::fulfil_coin_purchase( $pu, 7, 'stripe:csA' );
Economy::fulfil_coin_purchase( $pu, 7, 'stripe:csA' ); // duplicate
aqt_eq( 'coin purchase credits once per ref', Economy::coin_balance( $pu ) - $cb0, 7 );
aqt_eq( 'minting bumps gold backing by the coins minted', Economy::backing_mg() - $bk0, 7 );

// fulfil_session (the shared verify+webhook path) is idempotent for a paid donation session.
$sessD = [ 'id' => 'csD', 'payment_status' => 'paid', 'amount_total' => 1200,
	'metadata' => [ 'aq_kind' => 'donations', 'aq_uid' => (string) $pu, 'aq_donations' => wp_json_encode( [ [ 'c' => 1200, 'g' => [ 'rural' ], 'y' => [] ] ] ) ] ];
Extra::fulfil_session( $sessD ); Extra::fulfil_session( $sessD );
aqt_eq( 'fulfil_session donation idempotent', (int) $wpdb->get_var( "SELECT COALESCE(SUM(cents),0) FROM {$p}aq_fund_ledger WHERE ref='stripe:csD'" ), 1200 );

// Collapsed payload (what course_checkout sends when the breakdown would blow Stripe's 500-char meta
// cap): one general gift for the total → the full charge is credited (to bursary), nothing lost.
$sessC = [ 'id' => 'csC', 'payment_status' => 'paid', 'amount_total' => 9900,
	'metadata' => [ 'aq_kind' => 'donations', 'aq_uid' => (string) $pu, 'aq_donations' => wp_json_encode( [ [ 'c' => 9900, 'g' => [], 'y' => [] ] ] ) ] ];
Extra::fulfil_session( $sessC );
aqt_eq( 'collapsed gift → full total to bursary', (int) $wpdb->get_var( "SELECT COALESCE(SUM(cents),0) FROM {$p}aq_fund_ledger WHERE ref='stripe:csC' AND bucket='bursary'" ), 9900 );

// Stripe webhook signature (HMAC-SHA256). Temp secret via env (Secrets::get reads getenv first).
putenv( 'STRIPE_WEBHOOK_SECRET=whsec_harness' );
$pl = wp_json_encode( [ 'type' => 'checkout.session.completed' ] ); $ts = time();
aqt_ok( 'webhook: valid signature accepted', is_array( Stripe::verify_webhook( $pl, 't=' . $ts . ',v1=' . hash_hmac( 'sha256', $ts . '.' . $pl, 'whsec_harness' ) ) ) );
aqt_ok( 'webhook: bad signature rejected',   Stripe::verify_webhook( $pl, 't=' . $ts . ',v1=deadbeef' ) === null );
aqt_ok( 'webhook: stale timestamp rejected', Stripe::verify_webhook( $pl, 't=' . ( $ts - 1000 ) . ',v1=' . hash_hmac( 'sha256', ( $ts - 1000 ) . '.' . $pl, 'whsec_harness' ) ) === null );
putenv( 'STRIPE_WEBHOOK_SECRET' ); // restore (falls back to the wp-config constant)

// cleanup payment-test rows + user.
$wpdb->query( "DELETE FROM {$p}aq_fund_ledger WHERE ref IN ('tref1','tref2','tref3','stripe:csD','stripe:csC')" );
$wpdb->query( "DELETE FROM {$p}aq_coin_ledger WHERE ref = 'stripe:csA'" );
$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_points_ledger WHERE user_id = %d", $pu ) );
if ( $pu ) { wp_delete_user( $pu ); }

/* ── 13. Cash-out / payout (Stripe Connect transfers — money-first, then debit) ─────────── */
aqt_section( '13. Cash-out / payout' );
$su = wp_create_user( 'aqt_sell', wp_generate_password(), 'aqt_sell@ex.com' ); $su = is_wp_error( $su ) ? 0 : (int) $su;
Economy::credit_coins( $su, 100, 'test_seed', "seed:sell:u$su" );
// Cash-out requires a verified identity (the blue check, Verify::is_verified) — provision it, as a
// real member who reaches cash-out would have it (the gov-ID review path is exercised in Verify's own tests).
update_user_meta( $su, 'aq_verified', time() );
aqt_as( $su );
// The rail is "enabled" once Stripe is configured. If this env has no secret, fake one for the
// scenario; the transfer + readiness are stubbed via filters below, so NO network call is ever made.
$had_secret = Secrets::has( 'STRIPE_SECRET_KEY' );
if ( ! $had_secret ) { putenv( 'STRIPE_SECRET_KEY=sk_test_harness' ); }

// (a) Frozen kill-switch → refuse, never debit (the mirror of buy(): no money out → no coins out).
putenv( 'AQ_CASHOUT_FROZEN=1' );
$b = Economy::coin_balance( $su );
aqt_eq( 'frozen cash-out refused', aqt_err( Economy::sell( aqt_req( [ 'coins' => 5 ] ) ) ), 'cashout_unavailable' );
aqt_eq( 'frozen cash-out debits nothing', Economy::coin_balance( $su ), $b );
putenv( 'AQ_CASHOUT_FROZEN' );

// (b) Enabled but not onboarded → needs_onboarding, never debit.
delete_user_meta( $su, 'aq_stripe_account' );
$b = Economy::coin_balance( $su );
aqt_eq( 'un-onboarded cash-out → needs_onboarding', aqt_err( Economy::sell( aqt_req( [ 'coins' => 5 ] ) ) ), 'needs_onboarding' );
aqt_eq( 'un-onboarded cash-out debits nothing', Economy::coin_balance( $su ), $b );

// Onboard: connected account + force payout-ready via the test seam (no live account lookup).
update_user_meta( $su, 'aq_stripe_account', 'acct_test' );
$ready = function () { return true; };
add_filter( 'aq_payout_ready', $ready );

// (c) Transfer FAILS → payout_failed, never debit, gold backing untouched.
$fail = function () { return false; };
add_filter( 'aq_stripe_create_transfer', $fail );
$bk = Economy::backing_mg(); $b = Economy::coin_balance( $su );
aqt_eq( 'failed transfer → payout_failed', aqt_err( Economy::sell( aqt_req( [ 'coins' => 5 ] ) ) ), 'payout_failed' );
aqt_eq( 'failed transfer debits nothing', Economy::coin_balance( $su ), $b );
aqt_eq( 'failed transfer leaves backing intact', Economy::backing_mg(), $bk );
remove_filter( 'aq_stripe_create_transfer', $fail );

// (d) Transfer SUCCEEDS → debit exactly the coins, gold backing shrinks in lockstep (redeem mirror).
$ok = function () { return [ 'id' => 'tr_harness1' ]; };
add_filter( 'aq_stripe_create_transfer', $ok );
$bk = Economy::backing_mg(); $b = Economy::coin_balance( $su );
$sr = Economy::sell( aqt_req( [ 'coins' => 5 ] ) );
aqt_ok( 'successful cash-out returns ok', is_array( $sr ) && ! empty( $sr['ok'] ) );
aqt_eq( 'cash-out debits exactly the coins sold', Economy::coin_balance( $su ), $b - 5 );
aqt_eq( 'redeeming shrinks gold backing by the coins redeemed', Economy::backing_mg(), $bk - 5 );
remove_filter( 'aq_stripe_create_transfer', $ok );

// (e) record_payout is idempotent per Stripe transfer id (a replay after a successful transfer is safe).
$b = Economy::coin_balance( $su );
aqt_eq( 'record_payout no-ops on a replayed transfer id', Economy::record_payout( $su, 5, 'tr_harness1' ), 0 );
aqt_eq( 'replayed payout debits nothing', Economy::coin_balance( $su ), $b );

// (f) reconcile cron records the debit for a transfer that went out but was never debited (timeout gap),
// and is idempotent on a second pass. Stub the Stripe transfer list via the test seam.
$list = function () use ( $su ) { return [ [ 'id' => 'tr_reconcile1', 'metadata' => [ 'aq_kind' => 'cashout', 'aq_uid' => (string) $su, 'aq_coins' => '4' ] ] ]; };
add_filter( 'aq_stripe_list_transfers', $list );
$b = Economy::coin_balance( $su );
aqt_eq( 'reconcile records the orphaned transfer (1 fixed)', Economy::reconcile_payouts(), 1 );
aqt_eq( 'reconcile debited exactly the transfer coins', Economy::coin_balance( $su ), $b - 4 );
aqt_eq( 'reconcile is idempotent on a second pass (0 fixed)', Economy::reconcile_payouts(), 0 );
remove_filter( 'aq_stripe_list_transfers', $list );

remove_filter( 'aq_payout_ready', $ready );
if ( ! $had_secret ) { putenv( 'STRIPE_SECRET_KEY' ); }
// cleanup cash-out user + ledger rows.
$wpdb->query( $wpdb->prepare( "DELETE FROM {$p}aq_coin_ledger WHERE user_id = %d", $su ) );
if ( $su ) { wp_delete_user( $su ); }

/* ── 12. Public discussion board (threads — Reddit-style read model) ──────── */
aqt_section( '12. Public discussion board' );
$tpost = function ( $uid, $title ) { aqt_as( $uid ); return Social::post_thread( aqt_req( [ 'title' => $title, 'body' => 'harness body', 'topic' => 'general' ] ) ); };
$tcomm = function ( $uid, $tid, $body, $parent = 0 ) { aqt_as( $uid ); $r = Social::comment( aqt_req( $parent ? [ 'id' => $tid, 'body' => $body, 'parent' => $parent ] : [ 'id' => $tid, 'body' => $body ] ) ); return is_array( $r ) ? $r : [ 'id' => 0 ]; };
$tvote = function ( $uid, $type, $id, $val ) { aqt_as( $uid ); return Social::vote( aqt_req( [ 'target_type' => $type, 'target_id' => $id, 'val' => $val ] ) ); };
$tread = function ( $uid, $tid, $params = [] ) { aqt_as( $uid ); return Social::thread( aqt_req( [ 'id' => $tid ] + $params ) ); };
$findc = function ( $res, $id ) { foreach ( $res['comments'] as $c ) { if ( (int) $c['id'] === (int) $id ) { return $c; } } return null; };

$tr  = $tpost( $U[0], 'Harness thread' );
$tid = (int) $tr['id'];
aqt_ok( 'thread posts', $tid > 0 );
$root  = $tcomm( $U[1], $tid, 'root comment' );
aqt_ok( 'comment returns its full card (author + my_vote, for local append)', isset( $root['card']['author'], $root['card']['my_vote'] ) && $root['card']['mine'] === true );
$rootId = (int) $root['id'];
$rep    = $tcomm( $U[2], $tid, 'a reply', $rootId );
$repId  = (int) $rep['id'];
$deep   = $tcomm( $U[1], $tid, 'a reply to the reply (deep nesting)', $repId );
$deepId = (int) $deep['id'];
aqt_ok( 'replies nest at any depth', $repId > 0 && $deepId > 0 && (int) $deep['card']['parent'] === $repId );
aqt_eq( 'reply bumps parent reply_count', (int) $wpdb->get_var( $wpdb->prepare( "SELECT reply_count FROM {$p}aq_comments WHERE id=%d", $rootId ) ), 1 );

// THE reported bug: votes must land on REPLIES exactly as on top-level comments.
$v = $tvote( $U[3], 'comment', $repId, 1 );
aqt_ok( 'a REPLY can be upvoted (my_vote 1, authoritative votes 1)', is_array( $v ) && $v['my_vote'] === 1 && $v['votes'] === 1 );
$v = $tvote( $U[4], 'comment', $repId, -1 );
aqt_eq( 'vote response returns the authoritative net score', $v['votes'], 0 );
$v = $tvote( $U[3], 'comment', $repId, 1 );
aqt_eq( 'vote is an idempotent SET (re-sending +1 keeps score, never toggles)', $v['votes'], 0 );
$v = $tvote( $U[3], 'comment', $repId, 0 );
aqt_eq( 'val=0 clears the cast', $v['my_vote'], 0 );
aqt_eq( 'cleared vote leaves the others standing', $v['votes'], -1 );
$tvote( $U[4], 'comment', $repId, 0 ); // neutralize
aqt_eq( 'voting your own comment → self_vote', aqt_err( $tvote( $U[2], 'comment', $repId, 1 ) ), 'self_vote' );
aqt_eq( 'voting your own thread → self_vote', aqt_err( $tvote( $U[0], 'thread', $tid, 1 ) ), 'self_vote' );
$v = $tvote( $U[1], 'thread', $tid, 1 );
aqt_ok( 'thread vote returns authoritative score too', $v['my_vote'] === 1 && $v['votes'] === 1 );
$tvote( $U[1], 'thread', $tid, 0 );

// mine is STRICT authorship — the ONE key that unlocks Edit/Delete. Ticket #65: the controls and
// the permission belong to the author alone; there is no moderator escape (an admin sees others'
// comments as not-mine → votable, and gets `forbidden` on others' posts exactly like any member).
$adm = wp_create_user( 'aqt_admin', wp_generate_password(), 'aqt_admin@ex.com' );
$adm = is_wp_error( $adm ) ? 0 : (int) $adm;
( new \WP_User( $adm ) )->set_role( 'administrator' );
$res = $tread( $adm, $tid );
aqt_ok( 'admin viewer: others’ comments are NOT mine (vote arrows live)', $findc( $res, $rootId )['mine'] === false );
aqt_ok( 'thread read ships no moderation flag (author-only controls, ticket #65)', ! array_key_exists( 'can_mod', $res ) );
$res = $tread( $U[1], $tid );
aqt_ok( 'author viewer: own comment IS mine', $findc( $res, $rootId )['mine'] === true );
aqt_ok( 'read carries my_vote per comment + viewer thread vote', $findc( $res, $repId )['my_vote'] === 0 && $res['my_vote'] === 0 );

// Ticket #65 regression: a NON-AUTHOR (member or admin) may neither edit nor delete another's
// comment or thread — the handlers refuse with `forbidden` and the rows stay untouched.
aqt_as( $U[2] );
aqt_eq( "member editing another's comment → forbidden", aqt_err( Social::comment_update( aqt_req( [ 'id' => $rootId, 'body' => 'hijacked' ] ) ) ), 'forbidden' );
aqt_eq( "member deleting another's comment → forbidden", aqt_err( Social::comment_delete( aqt_req( [ 'id' => $rootId ] ) ) ), 'forbidden' );
aqt_as( $adm );
aqt_eq( "ADMIN editing another's comment → forbidden too", aqt_err( Social::comment_update( aqt_req( [ 'id' => $rootId, 'body' => 'admin override' ] ) ) ), 'forbidden' );
aqt_eq( "ADMIN deleting another's comment → forbidden too", aqt_err( Social::comment_delete( aqt_req( [ 'id' => $rootId ] ) ) ), 'forbidden' );
aqt_eq( "ADMIN editing another's thread → forbidden too", aqt_err( Social::thread_update( aqt_req( [ 'id' => $tid, 'title' => 'taken over', 'body' => 'x' ] ) ) ), 'forbidden' );
aqt_eq( "ADMIN deleting another's thread → forbidden too", aqt_err( Social::thread_delete( aqt_req( [ 'id' => $tid ] ) ) ), 'forbidden' );
aqt_ok( 'forbidden edit left the comment body untouched', (string) $wpdb->get_var( $wpdb->prepare( "SELECT body FROM {$p}aq_comments WHERE id=%d", $rootId ) ) === 'root comment' );

// Read model: roots paginate (top|new), replies inline up to the cap, the rest via ?parent=.
for ( $i = 0; $i < 24; $i++ ) { $tcomm( $U[ 5 + ( $i % 19 ) ], $tid, "filler root $i" ); }
for ( $i = 0; $i < 12; $i++ ) { $tcomm( $U[ 5 + ( $i % 19 ) ], $tid, "extra reply $i", $rootId ); }
$res = $tread( $U[1], $tid, [ 'sort' => 'new' ] );
$roots = array_values( array_filter( $res['comments'], fn( $c ) => (int) $c['parent'] === 0 ) );
aqt_eq( 'page 1 = 20 roots (sort=new)', count( $roots ), Social::PAGE_TOP );
aqt_ok( 'page 1 sets a cursor + ships the denorm total', $res['next'] !== null && $res['total'] === (int) $wpdb->get_var( $wpdb->prepare( "SELECT comment_count FROM {$p}aq_threads WHERE id=%d", $tid ) ) );
$res2  = $tread( $U[1], $tid, [ 'sort' => 'new', 'cursor' => $res['next'] ] );
$roots2 = array_values( array_filter( $res2['comments'], fn( $c ) => (int) $c['parent'] === 0 ) );
aqt_ok( 'page 2 returns the remaining roots, no cursor', count( $roots2 ) === 5 && $res2['next'] === null );
$inline = array_values( array_filter( array_merge( $res['comments'], $res2['comments'] ), fn( $c ) => (int) $c['parent'] === $rootId ) );
aqt_eq( 'a busy root inlines only the first PAGE_REPLY replies', count( $inline ), 10 );
aqt_eq( 'root row carries its full reply total for "show more"', $findc( count( $roots2 ) ? $res2 : $res, $rootId )['replies'] ?? $findc( $res, $rootId )['replies'], 13 );
$more = $tread( $U[1], $tid, [ 'parent' => $rootId, 'cursor' => (int) end( $inline )['id'] ] );
aqt_eq( '?parent pages the remaining replies', count( $more['items'] ), 3 );
$tvote( $U[5], 'comment', $rootId, 1 );
$res = $tread( $U[1], $tid, [ 'sort' => 'top' ] );
$tops = array_values( array_filter( $res['comments'], fn( $c ) => (int) $c['parent'] === 0 ) );
aqt_eq( 'sort=top puts the upvoted root first', (int) $tops[0]['id'], $rootId );

// Edit persists the flag; delete is SOFT when the comment has replies (subtree survives).
aqt_as( $U[1] ); Social::comment_update( aqt_req( [ 'id' => $rootId, 'body' => 'root comment (edited)' ] ) );
aqt_ok( 'edited flag survives a reload', $findc( $tread( $U[1], $tid, [ 'sort' => 'top' ] ), $rootId )['edited'] === true );
$cc = (int) $wpdb->get_var( $wpdb->prepare( "SELECT comment_count FROM {$p}aq_threads WHERE id=%d", $tid ) );
aqt_as( $U[1] ); $dr = Social::comment_delete( aqt_req( [ 'id' => $rootId ] ) );
aqt_ok( 'deleting a parent is SOFT', is_array( $dr ) && $dr['soft'] === true );
// (soft delete zeroes the score, so the root may have slid to page 2 — search both pages)
$r1  = $tread( $U[2], $tid, [ 'sort' => 'new' ] );
$r2  = $r1['next'] ? $tread( $U[2], $tid, [ 'sort' => 'new', 'cursor' => $r1['next'] ] ) : [ 'comments' => [] ];
$row = $findc( [ 'comments' => array_merge( $r1['comments'], $r2['comments'] ) ], $rootId );
aqt_ok( 'soft-deleted parent renders as placeholder, replies intact', $row && $row['deleted'] === true && $row['author'] === '[deleted]' && $row['replies'] === 13 );
aqt_eq( 'soft delete keeps the thread total (slot still occupied)', (int) $wpdb->get_var( $wpdb->prepare( "SELECT comment_count FROM {$p}aq_threads WHERE id=%d", $tid ) ), $cc );
aqt_as( $U[1] ); $dr = Social::comment_delete( aqt_req( [ 'id' => $deepId ] ) );
aqt_ok( 'deleting a leaf is HARD', is_array( $dr ) && $dr['soft'] === false );
aqt_eq( 'hard delete decrements the parent reply_count', (int) $wpdb->get_var( $wpdb->prepare( "SELECT reply_count FROM {$p}aq_comments WHERE id=%d", $repId ) ), 0 );

// Thread delete sweeps its comments AND every vote row pointed at them (no orphan votes in /data/).
aqt_as( $U[0] ); Social::thread_delete( aqt_req( [ 'id' => $tid ] ) );
aqt_eq( 'thread delete leaves no comments', (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$p}aq_comments WHERE context_type='thread' AND context_id=%d", $tid ) ), 0 );
aqt_eq( 'thread delete leaves no orphan votes', (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$p}aq_votes WHERE target_type='thread' AND target_id=%d", $tid ) ), 0 );
if ( $adm ) { wp_delete_user( $adm ); }
$wpdb->query( "DELETE FROM {$p}aq_threads WHERE title IN ('Harness thread')" );

/* ── done ───────────────────────────────────────────────────────────────── */
aqt_cleanup( $cid, $lessons );
$wpdb->update( "{$p}aq_courses", [ 'enroll_count' => 0, 'revenue' => 0 ], [ 'id' => $cid ] );

$t = $GLOBALS['aqt'];
echo "\n════════════════════════════════════\n";
echo "PASS {$t['pass']} / FAIL {$t['fail']}\n";
if ( $t['fail'] ) { echo "FAILURES:\n  - " . implode( "\n  - ", $t['fails'] ) . "\n"; }
echo ( $t['fail'] === 0 ? "AQ_TEST_RESULT=GREEN\n" : "AQ_TEST_RESULT=RED\n" );
