#!/bin/bash
# Submit a competition SOLUTION for adversarial review ON PROD as a given member, through the real
# handler (AQ\Competitions::request_review) — attaches an open code URL + a method write-up to the
# member's best submission and queues it for the ArtaCompete reviewer.
#
#   tools/comp-verify.sh <slug> <uid> <code-url> <method-file-or-text> [submission_id]
#
# Prints the JSON: {"ok":true,"submission_id":…,"review":"submitted","round":…} or {"error":…,"message":…}.
# Values are base64-baked into the PHP (never through a shell/ssh argv), so quotes/semicolons are safe.
set -euo pipefail
SLUG="$1"; MUID="$2"; CODE="$3"; METHOD_SRC="$4"; SUBID="${5:-0}"
METHOD="$METHOD_SRC"; [ -f "$METHOD_SRC" ] && METHOD="$(cat "$METHOD_SRC")"

b64() { openssl base64 -A; }
SLUG_B=$(printf '%s' "$SLUG" | b64)
CODE_B=$(printf '%s' "$CODE" | b64)
METHOD_B=$(printf '%s' "$METHOD" | b64)
UID_INT=$(( MUID )); SUB_INT=$(( SUBID ))

TMP="/tmp/aq-verify-$$-${RANDOM}.php"
cat > "$TMP" <<PHP
<?php
wp_set_current_user( ${UID_INT} );
\$req = new WP_REST_Request( 'POST', '/aq/v1/competition/verify' );
\$req->set_param( 'slug', base64_decode( '${SLUG_B}' ) );
\$req->set_param( 'code_url', base64_decode( '${CODE_B}' ) );
\$req->set_param( 'method', base64_decode( '${METHOD_B}' ) );
if ( ${SUB_INT} > 0 ) { \$req->set_param( 'submission_id', ${SUB_INT} ); }
\$res = AQ\\Competitions::request_review( \$req );
if ( \$res instanceof WP_REST_Response ) { echo json_encode( \$res->get_data() ) . "\n"; }
elseif ( \$res instanceof WP_Error ) { echo json_encode( [ 'ok' => false, 'error' => \$res->get_error_message() ] ) . "\n"; }
else { echo json_encode( \$res ) . "\n"; }
PHP

REMOTE="/tmp/aq-verify-$$-${RANDOM}.php"
scp -q "$TMP" "artaquest:$REMOTE"
rm -f "$TMP"
ssh artaquest "cd /srv/htdocs && wp eval-file '$REMOTE'; rm -f '$REMOTE'"
