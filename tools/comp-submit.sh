#!/bin/bash
# Submit competition predictions ON PROD as a given member, through the REAL scorer
# (AQ\Competitions::submit — same parsing, throttle, deadline and leaderboard path as the SPA).
#
#   tools/comp-submit.sh <slug> <uid> <csv-or-json-file> [note] [code_url]
#
# Prints the scorer's JSON: {"ok":true,"score":…,"best":…,"rank":…} or {"error":…,"message":…}.
# Used by the skills-500 competitor agents; needs the `artaquest` ssh alias.
#
# code_url (a public, reproducible Colab/repo link) is REQUIRED by Competitions::submit on every
# predictive submission (operator 2026-07-07). Defaults to the competition's own hosted reference
# solution, so the platform baseline itself always ships open, reproducible code.
#
# The prediction BODY is gzipped and scp'd as a file the remote PHP reads (robust at any size — a
# full 26k-row submission is too large to bake into the PHP/argv). slug/uid/note/code are base64
# literals in the PHP (never a shell/ssh argv), so quotes/semicolons can't break out and run commands.
set -euo pipefail
SLUG="$1"; MUID="$2"; FILE="$3"; NOTE="${4:-}"
CODE="${5:-https://artaquest.com/wp-content/uploads/competitions/$SLUG/reference_solution.py}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }

b64() { openssl base64 -A; }
SLUG_B=$(printf '%s' "$SLUG" | b64)
NOTE_B=$(printf '%s' "$NOTE" | b64)
CODE_B=$(printf '%s' "$CODE" | b64)
UID_INT=$(( MUID ))                                # force integer (rejects anything non-numeric)

STAMP="$$-${RANDOM}"
RBODY="/tmp/aq-sub-${STAMP}.csv.gz"
RPHP="/tmp/aq-sub-${STAMP}.php"
LGZ="/tmp/aq-sub-${STAMP}.local.gz"
gzip -c "$FILE" > "$LGZ"
scp -q "$LGZ" "artaquest:$RBODY"
rm -f "$LGZ"

TMP="/tmp/aq-sub-${STAMP}.local.php"
cat > "$TMP" <<PHP
<?php
\$slug = base64_decode( '${SLUG_B}' );
\$uid  = ${UID_INT};
\$note = base64_decode( '${NOTE_B}' );
\$code = base64_decode( '${CODE_B}' );
\$body = (string) gzdecode( (string) file_get_contents( '${RBODY}' ) );
@unlink( '${RBODY}' );
wp_set_current_user( \$uid );
\$req = new WP_REST_Request( 'POST', '/aq/v1/competition/submit' );
\$req->set_param( 'slug', \$slug );
\$req->set_param( 'code_url', \$code );
if ( \$note !== '' ) { \$req->set_param( 'note', \$note ); }
\$req->set_body( \$body );
\$req->set_header( 'Content-Type', 'text/csv' );
\$res = AQ\\Competitions::submit( \$req );
if ( \$res instanceof WP_REST_Response ) { echo json_encode( \$res->get_data() ) . "\n"; }
elseif ( \$res instanceof WP_Error ) { echo json_encode( [ 'ok' => false, 'error' => \$res->get_error_message() ] ) . "\n"; }
else { echo json_encode( \$res ) . "\n"; }
PHP
scp -q "$TMP" "artaquest:$RPHP"
rm -f "$TMP"
ssh artaquest "cd /srv/htdocs && wp eval-file '$RPHP'; rm -f '$RPHP'"
