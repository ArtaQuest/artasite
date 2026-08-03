#!/bin/bash
# Create the Journal of Seasonality submission row on prod (mirrors AQ\Science::submit). Run AFTER
# finalize_submit.sh has hosted the artifacts and all five URLs return 200.
#   bash journal/seasonality2/submit.sh
# Robust path: generate a clean PHP file, scp it into the webroot, `wp eval require` it, then delete it
# (avoids bash->ssh->wp-eval->PHP quote nesting).
set -uo pipefail
SSH="ssh -o BatchMode=yes -o ConnectTimeout=25 artaquest"
SCP="scp -o BatchMode=yes -o ConnectTimeout=25"
TMP=$(mktemp /tmp/aq_submit2.XXXXXX.php)

cat > "$TMP" <<'PHP'
<?php
$now = \AQ\Data::now();
$id = \AQ\Data::insert('aq_submissions', [
  'author_id' => 138324856,
  'title'     => 'Globally-Anchored, Robust Seasonality in Worldwide Search Interest, and the Scale-Invariance of Period-Sinc Kernels',
  'abstract'  => <<<ABS
We revisit a transparent curve-fitting question - does the timing of worldwide curiosity, indexed by Google Trends, line up with the positions of celestial bodies? - and harden it in three ways, keeping the honest stance that correlation is not causation. (i) We put every series on a global popularity scale: each query is measured in the same request against two fixed reference words ("arta" and "quest"), so interest is comparable across topics, not normalised to each one's own maximum. (ii) We drop the cube-root transform of prior work and fit raw interest under a robust Huber loss, moving the defence against spikes from the data into the estimator. (iii) We add a single global multiplier to the period-scaled sinc kernel and show, analytically and empirically, that the in-sample fit is invariant to it: the slow outer bodies that carry the fit sit in the kernel's quadratic flat-top, where rescaling the width is absorbed exactly by the non-negative weights, so the global scale is a redundant parameter. For a balanced design covering all twelve zodiac houses with both a noun and an adjective field, we fit 22 years of stitched weekly interest with the same fourteen-number model. Three honest bounds (a data-optimal PCA ceiling, a no-astrology trend-plus-annual baseline, and invariance to the zodiac convention) show the fit is a compact re-description of trend and annual seasonality, not evidence of celestial influence. All data and code are open and the headline numbers reproduce by running the released script.
ABS,
  'data_url'  => 'https://artaquest.org/wp-content/uploads/research/series2.json',
  'code_url'  => 'https://artaquest.org/papers/seasonality2/code.zip',
  'paper_url' => 'https://artaquest.org/papers/seasonality2/paper.zip',
  'consent'   => 1,
  'status'    => 'submitted',
  'round'     => 1,
  'created'   => $now,
  'updated'   => $now,
]);
echo $id ? "SUBMISSION_ID=$id" : "INSERT_FAILED";
PHP

echo "Uploading submission script + inserting row…"
$SCP "$TMP" artaquest:/srv/htdocs/aq_submit2.php
$SSH 'wp eval "require ABSPATH . \"aq_submit2.php\";"; rm -f /srv/htdocs/aq_submit2.php'
rm -f "$TMP"
echo
echo "If SUBMISSION_ID printed above, the paper is in the review queue (status 'submitted')."
echo "Ensure the reviewer relay is running: tools/ticket-agent/artascience-relay.mjs"
