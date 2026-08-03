#!/bin/bash
# Submit an entry to a CHANT competition (metric 'chant') ON PROD as a given member.
#
#   tools/naming-submit.sh <slug> <uid> <laws-file> [note]
#
# The laws file is plain text: the TWELVE law sentences, one per line (optional leading "1." numbers
# are stripped). That is the whole entry — no judge is involved. The chant relay then translates the
# laws into the 20 mesh languages (ArtaTranslate), speaks all 240 lines (ArtaVoice / Edge TTS), and
# posts the TOTAL SPOKEN SECONDS as the board score (lowest wins); the full per-language table lands
# publicly in Solutions.
#
# Transport hardening mirrors comp-submit.sh: the body ships as a scp'd file; slug/uid/note are
# base64 literals inside the PHP (never shell/ssh argv), so quotes can't break out on prod.
set -euo pipefail
SLUG="$1"; MUID="$2"; FILE="$3"; NOTE="${4:-}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }

b64() { openssl base64 -A; }
SLUG_B=$(printf '%s' "$SLUG" | b64)
NOTE_B=$(printf '%s' "$NOTE" | b64)
UID_INT=$(( MUID ))

STAMP="$$-${RANDOM}"
RBODY="/tmp/aq-name-${STAMP}.txt.gz"
RPHP="aq-name-${STAMP}.php"
LGZ="/tmp/aq-name-${STAMP}.local.gz"
gzip -c "$FILE" > "$LGZ"
scp -q "$LGZ" "artaquest:$RBODY"
rm -f "$LGZ"

TMP="/tmp/aq-name-${STAMP}.local.php"
cat > "$TMP" <<PHP
<?php
require_once WP_PLUGIN_DIR . '/aquest/src/Data.php';
\$slug = base64_decode( '${SLUG_B}' );
\$note = mb_substr( base64_decode( '${NOTE_B}' ), 0, 255 );
\$uid  = ${UID_INT};
\$comp = AQ\Data::one( 'SELECT id, metric, status FROM ' . AQ\Data::t('aq_competitions') . ' WHERE slug = %s', [ \$slug ] );
if ( ! \$comp ) { echo json_encode( [ 'error' => 'not_found' ] ); return; }
if ( ! in_array( \$comp['metric'], [ 'chant', 'artaverify' ], true ) ) { echo json_encode( [ 'error' => 'wrong_metric' ] ); return; }
if ( \$comp['status'] !== 'active' ) { echo json_encode( [ 'error' => 'closed' ] ); return; }
\$body = gzdecode( (string) file_get_contents( '${RBODY}' ) );
if ( \$body === false || trim( (string) \$body ) === '' ) { echo json_encode( [ 'error' => 'empty' ] ); return; }
\$laws = [];
foreach ( preg_split( '/[\n\r]+/', (string) \$body ) as \$l ) {
	\$l = trim( sanitize_text_field( \$l ) );
	if ( \$l !== '' ) { \$laws[] = mb_substr( preg_replace( '/^\s*\d+[.)]\s*/', '', \$l ), 0, 90 ); }
}
if ( count( \$laws ) !== 12 ) { echo json_encode( [ 'error' => 'need_12_laws', 'got' => count( \$laws ) ] ); return; }
\$method = "THE TWELVE CHANTS:\n";
foreach ( \$laws as \$i => \$l ) { \$method .= ( \$i + 1 ) . '. ' . \$l . "\n"; }
\$now = current_time( 'mysql', true );
\$sid = AQ\Data::insert( 'aq_comp_subs', [
  'comp_id' => (int) \$comp['id'], 'uid' => \$uid,
  'note' => \$note, 'score' => 0, 'preds' => wp_json_encode( \$laws ), 'code_url' => '',
  'method' => trim( \$method ),
  'review' => 'submitted', 'review_round' => 0, 'verified' => 0, 'place' => 0,
  'created' => \$now, 'updated' => \$now,
] );
@unlink( '${RBODY}' );
echo json_encode( [ 'ok' => (bool) \$sid, 'submission_id' => (int) \$sid, 'review' => 'submitted' ] );
PHP
scp -q "$TMP" "artaquest:/tmp/${RPHP}"
rm -f "$TMP"
ssh artaquest "cd /srv/htdocs 2>/dev/null || cd ~/htdocs; cp /tmp/${RPHP} ${RPHP}; wp eval-file ${RPHP}; rm -f ${RPHP} /tmp/${RPHP}"
