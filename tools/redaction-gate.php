<?php
/**
 * WHAT THE PUBLIC DATABASE MAY AND MAY NOT PUBLISH — a regression gate.
 *
 * ArtaQuest publishes its entire database on purpose. That makes `Extra::redact_row` the single
 * place deciding what a stranger may read about a member, and it makes a silent widening of that
 * decision indistinguishable from normal work. This asserts BOTH directions:
 *
 *   • things that MUST be masked  — the email and everything that reconstructs it, the exact date
 *     of birth, an IP, a cross-service account id, a birth time, an opt-in-only field, and every
 *     credential shape;
 *   • things that MUST stay PUBLIC — password hashes (inert: Auth::harden disables password login),
 *     the Watchdog decoy traps (masking one disarms a live trap silently), the /u/ handle, and every
 *     self-declared profile fact. A privacy fix that quietly unpublishes the product is also a bug.
 *
 * It runs the REAL constants and the REAL redact_row/redact_reason, spliced verbatim out of
 * Extra.php at run time rather than copied — so the gate cannot drift away from the code it guards.
 * Its only WordPress dependency is $wpdb->prefix, which is stubbed.
 *
 * Usage: php tools/redaction-gate.php   (exit 0 = all assertions hold)
 */

$root = dirname( __DIR__ );
$file = $root . '/wp-content/plugins/aquest/src/Extra.php';
$src  = @file_get_contents( $file );
if ( $src === false ) { fwrite( STDERR, "cannot read $file\n" ); exit( 2 ); }

$want = [
	'REDACT_COLUMNS'   => '/\tconst REDACT_COLUMNS = \[.*?\n\t\];/s',
	'REDACT_KEYED'     => '/\tconst REDACT_KEYED = \[.*?\n\t\];/s',
	'REDACT_NAME_RE'   => '/\tconst REDACT_NAME_RE = .*?;/s',
	'REDACT_VALUE_RE'  => '/\tconst REDACT_VALUE_RE = .*?;/s',
	'REDACT_IDENTITY'  => '/\tconst REDACT_IDENTITY = \[.*?\n\t\];/s',
	'REDACT_PUBLIC'    => '/\tconst REDACT_PUBLIC = \[.*?\];/s',
	'PRIVATE_TABLES'   => '/\tconst PRIVATE_TABLES = \[.*?\];/s',
	'redact_row'       => '/\tpublic static function redact_row\(.*?\n\t\}/s',
	'redact_reason'    => '/\tprivate static function redact_reason\(.*?\n\t\}/s',
];
$parts = [];
foreach ( $want as $name => $re ) {
	// A rename or refactor that makes a section unfindable FAILS the gate rather than skipping it —
	// a check that silently matches nothing is worse than no check.
	if ( ! preg_match( $re, $src, $m ) ) { fwrite( STDERR, "redaction-gate: cannot find $name in Extra.php — refactored? update the gate.\n" ); exit( 2 ); }
	$parts[] = $m[0];
}
$body = str_replace(
	[ 'global $wpdb;', '$wpdb->prefix' ],
	[ '$wpdb = new StdPrefix();', "'wp_'" ],
	implode( "\n\n", $parts )
);
eval( 'class Watchdog { const TRAPS = [ \'aq_internal_admin_key\', \'aq_worker_token_backup\', \'aq_db_signing_secret\' ]; } class StdPrefix { public $prefix = \'wp_\'; } class Extra {' . $body . '}' );

$fails=0; $n=0;
$check=function($label,$got,$want) use (&$fails,&$n){
  $n++; $m = strpos((string)$got,'••• protected')===0; $ok=($m===$want); if(!$ok)$fails++;
  printf("%s  %-46s masked=%s want=%s\n", $ok?'PASS':'FAIL', $label, $m?'Y':'N', $want?'Y':'N');
};
// wp_users: the email AND everything that reconstructs it
$r=Extra::redact_row('wp_users',['user_email'=>'a@b.com','user_login'=>'a','user_nicename'=>'a','user_pass'=>'$wp$x','display_name'=>'A','user_activation_key'=>'k','user_registered'=>'2026-01-01']);
$check('users.user_email        → MASKED',$r['user_email'],true);
$check('users.user_login        → MASKED (rebuilds email)',$r['user_login'],true);
$check('users.user_nicename     → public (the /u/ handle)',$r['user_nicename'],false);
$check('users.user_pass         → public (Auth::harden)',$r['user_pass'],false);
$check('users.display_name      → public',$r['display_name'],false);
$check('users.user_registered   → public',$r['user_registered'],false);
$check('users.user_activation_key → masked',$r['user_activation_key'],true);
// usermeta identity
foreach(['aq_birthday'=>true,'wpcom_user_data'=>true,'community-events-location'=>true,
         'aq_google_sub'=>true,'aq_birth_min'=>true,'aq_gender'=>true,
         'aq_location'=>false,'aq_full_name'=>false,'aq_relationship'=>false,
         'aq_languages'=>false,'aq_last_seen'=>false,'aq_verified'=>false,
         'aq_palm_url'=>false,'aq_typology_tags'=>false,'description'=>false] as $k=>$w){
  $r=Extra::redact_row('wp_usermeta',['meta_key'=>$k,'meta_value'=>'X']);
  $check("usermeta.$k",$r['meta_value'],$w);
}
// decoys must stay live
foreach(Watchdog::TRAPS as $t){ $r=Extra::redact_row('wp_options',['option_name'=>$t,'option_value'=>'d']);
  $check("DECOY $t → public",$r['option_value'],false); }
// credential regression guard
foreach(['jetpack_private_options'=>true,'session_tokens'=>true,'auth_key'=>true,'nonce_salt'=>true,
         'aq_passkey_table_version'=>false,'aq_grants_authored'=>false,'disallowed_keys'=>false,
         'aq_recaptcha_site_key'=>false] as $k=>$w){
  $r=Extra::redact_row('wp_options',['option_name'=>$k,'option_value'=>'v']);
  $check("options.$k",$r['option_value'],$w); }
// aq_notifications: the prose columns NAME another member; the shape stays auditable.
$r=Extra::redact_row('wp_aq_notifications',['title'=>'X','body'=>'X','type'=>'dm','user_id'=>'1','created'=>'1','read'=>'0']);
foreach(['title'=>true,'body'=>true,'type'=>false,'user_id'=>false,'created'=>false,'read'=>false] as $c=>$w){
  $check("aq_notifications.$c",$r[$c],$w); }
// aq_meets keeps its existing masks — no regression from the entry added beside it.
$r=Extra::redact_row('wp_aq_meets',['title'=>'X','agenda'=>'X','id'=>'1']);
$check('aq_meets.title',$r['title'],true);
$check('aq_meets.agenda',$r['agenda'],true);
$check('aq_meets.id',$r['id'],false);
// Tables WITHHELD entirely — the DM metadata graph plus the two older promises.
foreach(['aq_chats','aq_chat_msgs','aq_doc_sources','aq_order_ship'] as $t){
  $in=in_array($t,Extra::PRIVATE_TABLES,true); $n++; if(!$in)$fails++;
  printf("%s  %-46s withheld=%s want=Y\n", $in?'PASS':'FAIL', "PRIVATE_TABLES has $t", $in?'Y':'N'); }
// ...and the tables that must NOT be withheld, or the product itself is gone.
foreach(['aq_notebooks','aq_votes','aq_coin_ledger','aq_books_line','aq_comments'] as $t){
  $in=in_array($t,Extra::PRIVATE_TABLES,true); $n++; if($in)$fails++;
  printf("%s  %-46s withheld=%s want=N\n", $in?'FAIL':'PASS', "PRIVATE_TABLES lacks $t", $in?'Y':'N'); }
printf("\n%s  %d/%d assertions\n", $fails===0?'✓ ALL PASS':"✗ $fails FAILED", $n-$fails, $n);
exit($fails===0?0:1);
