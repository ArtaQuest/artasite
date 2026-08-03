#!/bin/bash
# Finalize + submit the paper once collection has reached house coverage. Idempotent-ish; bounded ssh.
#   1. build the open data, 2. run reproduce.py (capture numbers), 3. fill the manuscript macros,
#   4. figures + PDF + zips, 5. host to prod (/papers/ + uploads/research/), 6. verify URLs,
#   7. create the submission row on prod. Run from repo root:  bash journal/seasonality2/finalize_submit.sh
set -uo pipefail
cd "$(dirname "$0")/../.."          # repo root
D=journal/seasonality2
SSH="ssh -o BatchMode=yes -o ConnectTimeout=25 artaquest"
FOUNDER=138324856

echo "== 1. build open data =="
python3 $D/code/make_data.py || exit 1

echo "== 2. reproduce (capture headline numbers) =="
( cd $D/code && python3 reproduce.py ) | tee /tmp/repro2.out
test -f $D/code/_results.json || { echo "no _results.json — abort"; exit 1; }

echo "== 3. fill manuscript macros =="
python3 - "$D" <<'PY'
import json, re, sys
D = sys.argv[1]
r = json.load(open(f"{D}/code/_results.json"))
tex = open(f"{D}/paper/main.tex").read()
sub = {"headlineN": r["n"], "headlineW": r["weeks"], "medianR": r["median_r2"], "meanR": r["mean_r2"],
       "scaleEps": r["scale_spread"], "scaleFlat": r["scale_flat"], "pcaMean": int(round(r["pca_mean"])),
       "baselineMean": int(round(r["baseline_mean"])), "zodiacEps": r["zodiac_eps"]}
for k, v in sub.items():
    tex = re.sub(r"(\\newcommand\{\\%s\}\{)[^}]*(\})" % k, lambda m: m.group(1) + str(v) + m.group(2), tex)
open(f"{D}/paper/main.tex", "w").write(tex)
print("filled:", sub)
PY

echo "== 4. figures + PDF + zips =="
( cd $D/code && python3 make_figs.py ) || echo "  (figures skipped)"
( cd $D/paper && tectonic main.tex >/tmp/tectonic2.out 2>&1 && echo "  PDF ok" ) || { echo "  PDF FAILED"; tail -20 /tmp/tectonic2.out; exit 1; }
rm -f $D/paper.zip $D/code.zip
( cd $D/paper && zip -q -X ../paper.zip main.tex artaquest.cls references.bib seasonality2_fig1.png seasonality2_fig2.png 2>/dev/null; zip -q -X ../paper.zip main.tex artaquest.cls references.bib )
( cd $D/code && zip -q -X ../code.zip reproduce.py make_data.py make_figs.py requirements.txt README.md series2.json ephemeris2.json )
ls -la $D/paper.zip $D/code.zip $D/paper/main.pdf

echo "== 5. host to prod =="
$SSH 'mkdir -p /srv/htdocs/papers/seasonality2 /srv/htdocs/wp-content/uploads/research'
scp -o BatchMode=yes -o ConnectTimeout=25 $D/paper.zip $D/code.zip $D/paper/main.pdf artaquest:/srv/htdocs/papers/seasonality2/ || exit 1
scp -o BatchMode=yes -o ConnectTimeout=25 $D/code/series2.json $D/code/ephemeris2.json artaquest:/srv/htdocs/wp-content/uploads/research/ || exit 1

echo "== 6. verify URLs (200) =="
for u in papers/seasonality2/paper.zip papers/seasonality2/code.zip papers/seasonality2/main.pdf \
         wp-content/uploads/research/series2.json wp-content/uploads/research/ephemeris2.json; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 "https://artaquest.org/$u")
  echo "  $code  https://artaquest.org/$u"
done

echo "== 7. create submission on prod =="
echo "  (run journal/seasonality2/submit.sh to insert the aq_submissions row once URLs are 200)"
