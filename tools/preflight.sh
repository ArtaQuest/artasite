#!/usr/bin/env bash
#
# preflight — every gate that stands between a change and production, in ONE place.
#
#   tools/preflight.sh                 # gate the commits this branch adds to artasite/main
#   tools/preflight.sh <base>          # ...against a different base
#   tools/preflight.sh --fast          # skip the build (inner loop; `ship` still runs it)
#
# WHY THIS FILE EXISTS. These checks used to live only inside .github/workflows, which meant the
# only way to run them was to push and wait — so the loop was "push, wait two minutes, read a log,
# fix, push again", and every gate had to be re-implemented by hand by anyone verifying locally.
# Worse, a gate written twice drifts: this repository has already shipped a lint step whose file
# filter matched nothing, and a typecheck that checked nothing, both of which reported success.
#
# So the workflows now CALL this script. There is one definition of "is this shippable", it runs the
# same way on a laptop and on a runner, and a gate that is wrong is wrong in one place.
#
# Exit 0 = every gate passed. Non-zero = do not push.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAST=0
BASE=""
for a in "$@"; do
  case "$a" in
    --fast) FAST=1 ;;
    *) BASE="$a" ;;
  esac
done

# Default base: what production is built from. Falls back sensibly in a shallow CI checkout or a
# fresh repository with no history to diff against.
if [ -z "$BASE" ]; then
  if git rev-parse -q --verify artasite/main >/dev/null 2>&1; then BASE="artasite/main"
  elif git rev-parse -q --verify HEAD~1     >/dev/null 2>&1; then BASE="HEAD~1"
  else BASE=""; fi
fi

# A BASE WE CANNOT RESOLVE MUST NOT LOOK LIKE A PASS. `git rev-parse <40-char sha>` SUCCEEDS for a
# sha this clone does not have — it echoes the string back instead of resolving it — so a caller
# cannot pre-validate with that alone, and every force-push hands us exactly such a sha, because
# github.event.before is then an orphan the runner never fetched.
#
# Unchecked, the damage is worse than a crash. `git diff` would yield nothing, so the changed-file
# gates would quietly examine an empty list; and the version gate reads the OLD version out of
# `git show $BASE:file`, which would come back empty, compare unequal to the current one, and report
# "version moved" for a push that never moved it. A gate that cannot read its signal has to abstain
# out loud, not answer yes.
if [ -n "$BASE" ] && ! git rev-parse -q --verify "${BASE}^{commit}" >/dev/null 2>&1; then
  printf "  ! base '%s' is not in this clone — the changed-file gates cannot run and are SKIPPED, not passed\n" "$BASE"
  BASE=""
fi

# GitHub reads ::error:: annotations; a terminal reads colour. Same script, both audiences.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  B=""; R=""; G=""; D=""; OFF=""
  fail() { echo "::error::$1"; }
else
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; D=$'\033[2m'; OFF=$'\033[0m'
  fail() { printf "%s  ✗ %s%s\n" "$R" "$1" "$OFF"; }
fi
ok()   { printf "%s  ✓ %s%s\n" "$G" "$1" "$OFF"; }
step() { printf "\n%s▶ %s%s\n" "$B" "$1" "$OFF"; }
skip() { printf "%s  ↷ %s%s\n" "$D" "$1" "$OFF"; }

BAD=0
mark() { BAD=1; }

# What this branch changes, for the gates that only apply to touched files.
#
# ON A LAPTOP THAT MUST INCLUDE UNCOMMITTED WORK. The whole point of running this before pushing is
# to hear about a problem while it is still cheap, and you run it before committing at least as often
# as after. Taking only the commit range meant the changed-file gates quietly examined nothing and
# reported clean — which is worse than not running them, because it looks like an answer. Caught by
# using it: two hashed PHP files edited, "no hashed PHP changed", and a missing version bump that CI
# would have refused an hour later.
#
# In CI there is nothing uncommitted, and `git status` on a runner is noise, so the range alone is
# the honest input there.
CHANGED=""
if [ -n "$BASE" ]; then CHANGED="$(git diff --name-only "$BASE"...HEAD 2>/dev/null || true)"; fi
if [ -z "${GITHUB_ACTIONS:-}" ]; then
  CHANGED="$(printf '%s\n%s\n' "$CHANGED" "$(git status --porcelain 2>/dev/null | sed 's/^...//' | sed 's/.* -> //')" | sort -u | sed '/^$/d')"
fi
changed_match() { [ -n "$CHANGED" ] && echo "$CHANGED" | grep -qE "$1"; }

# ── 1. Nothing key-shaped, and no machine attribution ──────────────────────────────────────────
# Both answer "is this fit to be public", and both cost a second. artasite is a PUBLIC repository.
step "Hygiene — secrets and attribution"
# YouTube's InnerTube Android key is a constant shipped in every copy of the app: not ours, not
# rotatable, allowed BY EXACT VALUE rather than by weakening the pattern.
ALLOW='AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w'
KEYPAT='(sk-ant-[A-Za-z0-9_-]{20,})|(ghp_[A-Za-z0-9]{30,})|(gho_[A-Za-z0-9]{30,})|(github_pat_[A-Za-z0-9_]{30,})|(AKIA[0-9A-Z]{16})|(ASIA[0-9A-Z]{16})|(sk_live_[A-Za-z0-9]{20,})|(rk_live_[A-Za-z0-9]{20,})|(hf_[A-Za-z0-9]{30,})|(xox[baprs]-[A-Za-z0-9-]{10,})|(AIza[0-9A-Za-z_-]{35})|(ya29\.[0-9A-Za-z_-]{20,})|(SG\.[A-Za-z0-9_-]{20,})|(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.)|(-----BEGIN [A-Z ]*PRIVATE KEY)'
hits=$(grep -rIlE "$KEYPAT" --exclude-dir=.git --exclude-dir=node_modules . 2>/dev/null || true)
n=0
# read -r, not `for`: a filename with a space became two nonexistent paths, both greps failed, and
# the step printed clean. Reproduced with a planted key in "my key.php".
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if grep -oIE "$KEYPAT" "$f" 2>/dev/null | grep -qv "$ALLOW"; then fail "$f holds a key-shaped value"; n=1; fi
done <<< "$hits"
[ $n -eq 0 ] && ok "no key-shaped values" || mark
# Ask GIT'S trailer parser, not a grep: only a trailer creates a GitHub contributor, and a grep also
# rejects an honest commit that merely writes ABOUT this rule.
if [ -n "$BASE" ]; then
  t=$(git log --format='%(trailers:key=Co-authored-by,valueonly)' "$BASE"..HEAD 2>/dev/null | tr -d '[:space:]')
  if [ -n "$t" ]; then fail "a commit in this range carries machine attribution as a git trailer"; mark
  else ok "no machine attribution"; fi
fi

# ── 2. Every route resolves ────────────────────────────────────────────────────────────────────
# Rest::ROUTES names handlers as STRINGS, so a missing class or method is invisible to php -l, tsc
# and the bundler — and answers 500 on whatever route names it. This once shipped two dead endpoints.
step "Route handlers resolve"
pat="^[[:space:]]*\[[[:space:]]*'(GET|POST|PUT|PATCH|DELETE)'[[:space:]]*,[[:space:]]*'[^']*'[[:space:]]*,[[:space:]]*'([A-Z][A-Za-z0-9_]+::[a-z0-9_]+)'"
src=wp-content/plugins/aquest/src
rows=$(grep -cE "$pat" "$src/Rest.php" 2>/dev/null || echo 0)
if [ "$rows" -lt 100 ]; then
  # The pattern reads the ROW'S STRUCTURE. A previous version used a negated class that could not
  # cross a ']', silently skipping every route carrying a regex param — 279 of 398 rows checked,
  # reported success on the 30% it never read. A low count means the pattern broke, not the routes.
  fail "only $rows route rows matched — the pattern is broken, not the routes"; mark
else
  miss=0
  grep -oE "$pat" "$src/Rest.php" | grep -oE "'[A-Z][A-Za-z0-9_]+::[a-z0-9_]+'$" | tr -d "'" | sort -u > /tmp/aq-handlers.$$
  while IFS= read -r h; do
    c="${h%%::*}"; m="${h##*::}"
    if [ ! -f "$src/$c.php" ]; then fail "Rest::ROUTES names $h but $src/$c.php does not exist"; miss=1; continue; fi
    grep -qE "function[[:space:]]+$m[[:space:]]*\(" "$src/$c.php" || { fail "Rest::ROUTES names $h but $c.php defines no $m()"; miss=1; }
  done < /tmp/aq-handlers.$$
  [ $miss -eq 0 ] && ok "$rows rows, $(wc -l < /tmp/aq-handlers.$$ | tr -d ' ') handlers resolve" || mark
  rm -f /tmp/aq-handlers.$$
fi

# ── 3. Changed PHP carries a version bump ──────────────────────────────────────────────────────
# Integrity.php hashes plugin+theme PHP hourly on prod and alerts when the hash moved but the
# version did not — its signal for "edited in place on the server". A deploy that ships changed PHP
# under an unchanged version raises a CRITICAL that is a lie. /version is also the ONLY way to
# confirm a deploy landed. This used to be automatic inside `studio push`, which no longer exists.
step "Changed PHP carries a version bump"
if [ -z "$BASE" ]; then skip "no base to diff against"
else
  vcheck() { # label  file-regex  version-file  version-grep
    changed_match "$2" || return 0
    was=$(git show "$BASE:$3" 2>/dev/null | grep -iE "$4" | head -1 || true)
    now=$(grep -iE "$4" "$3" 2>/dev/null | head -1 || true)
    if [ "$was" = "$now" ]; then
      fail "$1 PHP changed but its version did not move — prod will read this as a tamper, and /version cannot confirm the deploy"; mark
    else ok "$1 version moved"; fi
  }
  # Separately, because they ship separately and Integrity checks theme PHP against style.css.
  vcheck "plugin" '^wp-content/plugins/aquest/([^/]+\.php|src/[^/]+\.php)$' \
         wp-content/plugins/aquest/aquest.php "define\( *.AQ_VERSION"
  vcheck "theme"  '^wp-content/themes/artaquest-theme/([^/]+\.php|includes/[^/]+\.php)$' \
         wp-content/themes/artaquest-theme/style.css '^ \* Version:'
  changed_match '^wp-content/(plugins|themes)/' || skip "no hashed PHP changed"
fi

# ── 4. Vendored satellite content is present ───────────────────────────────────────────────────
# Parts of this site are researched in their own repositories and vendored in (artagrants,
# artalife). A vendored file that goes missing is INVISIBLE: import_grants() returns silently,
# nothing 500s, nothing fails to build, and production serves an empty programme. It did, for weeks.
# Presence and usability only — never freshness, which would go red whenever an unrelated repo moved.
step "Vendored satellite content"
g=wp-content/plugins/aquest/data/outreach-grants.json
if [ ! -s "$g" ]; then fail "$g is missing or empty — run: node tools/grants-sync.mjs"; mark
elif n=$(node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const r=Array.isArray(d)?d:(d.grants||[]);if(!r.length)throw new Error('x');console.log(r.length)" "$g" 2>/dev/null); then
  ok "grant catalogue: $n funders"
else fail "$g does not parse, or holds no grants — run: node tools/grants-sync.mjs"; mark; fi
for f in artaquest-web/src/generated/arta/rig/arta.ts artaquest-web/src/generated/arta/render/Arta.tsx; do
  if [ ! -s "$f" ]; then fail "$f is missing — run: node tools/arta-sync.mjs"; mark
  elif ! grep -q 'GENERATED' "$f"; then
    # The banner names the upstream commit. Losing it means the copy was hand-edited here, which the
    # next sync silently overwrites — and forks the mascot in the meantime.
    fail "$f lost its GENERATED banner — edit it upstream in artalife, not here"; mark
  fi
done
grep -q GENERATED artaquest-web/src/generated/arta/render/Arta.tsx 2>/dev/null && ok "Arta vendored from artalife"

# ── 4b. Every API path is rooted ────────────────────────────────────────────────────────────────
# api.ts builds a request as `${BASE}${path}` with BASE = "/wp-json/aq/v1" and NO trailing slash, so a
# path that forgets its leading slash silently concatenates: "wallet/transfer" became
# "/wp-json/aq/v1wallet/transfer". That 404s as rest_no_route, and it fails ONLY in the browser —
# a curl against the real route answers 401 and looks like proof the endpoint is fine, which is
# exactly the false reassurance that let it ship. tsc cannot see it; it is a correct string.
step "API paths are rooted"
if [ -f artaquest-web/src/lib/api.ts ]; then
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync("artaquest-web/src/lib/api.ts", "utf8");
    const bad = [];
    // The first string literal handed to a request helper, whether inline or on the next line.
    const re = /\b(?:post|get|del|postForm)\s*(?:<[\s\S]*?>)?\s*\(\s*(?:\/\/[^\n]*\n|\s)*("([^"\\]|\\.)*"|`([^`\\]|\\.)*`)/g;
    let m;
    while ((m = re.exec(src))) {
      const lit = m[1];
      const body = lit.slice(1, -1);
      if (body.startsWith("${BASE}")) continue;   // explicit template form, already rooted below
      if (!body.startsWith("/")) bad.push(lit);
    }
    // And the template form must not glue a letter straight onto BASE.
    for (const t of src.match(/\$\{BASE\}[A-Za-z]/g) || []) bad.push(t);
    if (bad.length) {
      for (const b of bad) console.log("::error::api.ts request path is not rooted: " + b + "  (BASE has no trailing slash — start it with /)");
      process.exit(1);
    }
  ' && ok "every api.ts path starts at the root" || { fail "an api.ts request path would concatenate onto BASE"; mark; }
else
  skip "no api.ts"
fi

# ── 5. PHP syntax ──────────────────────────────────────────────────────────────────────────────
# The plugin and theme never reach a runtime in CI, so syntax is all that can be asserted.
step "PHP syntax"
PHP="${AQ_PHP_BIN:-php}"
command -v "$PHP" >/dev/null 2>&1 || PHP=/Applications/Studio.app/Contents/Resources/php-bin/8.4.23-studio-1/php
if ! command -v "$PHP" >/dev/null 2>&1; then fail "no php binary (set AQ_PHP_BIN)"; mark
else
  n=0; c=0
  while IFS= read -r f; do
    c=$((c+1)); "$PHP" -l "$f" >/dev/null 2>&1 || { fail "PHP syntax error: $f"; n=1; }
  done < <(git ls-files 'wp-content/plugins/aquest/**/*.php' 'wp-content/themes/artaquest-theme/**/*.php')
  [ $n -eq 0 ] && ok "$c files parse" || mark
fi

# ── 5b. Every aq_*() / AQ method call resolves ─────────────────────────────────────────────────
# php -l parses a file; it cannot see a call to something that does not exist. That is a RUNTIME
# fatal, and it took the public profile down twice on 2026-08-11 — once on a deleted method whose
# last caller survived a comment-filtered grep, once on a helper whose defining edit was discarded
# by a script that aborted after printing "added". Both files parsed perfectly.
step "Every aq_*() and AQ method call resolves"
if [ -f tools/undefined-calls.php ]; then
  if out=$("$PHP" tools/undefined-calls.php 2>&1); then ok "$(printf '%s' "$out" | tail -1)"
  else printf '%s\n' "$out" | sed 's/^/    /'; fail "undefined call(s) — a page load would fatal"; mark; fi
else skip "tools/undefined-calls.php missing"; fi

# ── 6. Typecheck, lint, build ──────────────────────────────────────────────────────────────────
step "Typecheck, lint, build"
if [ ! -d artaquest-web/node_modules ]; then
  ( cd artaquest-web && npm ci --no-audit --fund=false >/dev/null 2>&1 ) || { fail "npm ci failed"; mark; }
fi
# -p tsconfig.app.json IS REQUIRED. A bare `tsc --noEmit` resolves the solution-style root config,
# which references projects and checks NOTHING — it exits 0 on a tree full of errors.
( cd artaquest-web && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json ) && ok "tsc clean" || { fail "tsc failed"; mark; }
# Only what this push CHANGED. A full run reports ~35 pre-existing errors, and a gate that can never
# go green means nothing ever deploys.
if [ -n "$BASE" ]; then
  files=$(echo "$CHANGED" | grep -E '^artaquest-web/src/.*\.tsx?$' | sed 's|^artaquest-web/||' || true)
  # A file deleted in this range is not there to lint; passing it makes eslint exit non-zero on a
  # correct change.
  live=""; for f in $files; do [ -f "artaquest-web/$f" ] && live="$live $f"; done
  if [ -n "${live// /}" ]; then
    # shellcheck disable=SC2086
    ( cd artaquest-web && ./node_modules/.bin/eslint --no-warn-ignored $live ) && ok "eslint clean ($(echo $live | wc -w | tr -d ' ') changed)" || { fail "eslint failed"; mark; }
  else skip "no TS/TSX changed"; fi
fi
if [ "$FAST" = "1" ]; then skip "build skipped (--fast)"
else
  ( cd artaquest-web && npm run build >/dev/null 2>&1 ) && ok "bundle built" || { fail "vite build failed"; mark; }
  # A zero exit from the bundler is not proof the output is usable, and the deploy REPLACES the live
  # bundle, so a hollow build would take the site down.
  app=wp-content/themes/artaquest-theme/app
  files=$(find "$app" -type f 2>/dev/null | wc -l | tr -d ' ')
  entry=$(ls "$app"/assets/index-*.js 2>/dev/null | wc -l | tr -d ' ')
  if [ -f "$app/index.html" ] && [ "$entry" -ge 1 ] && [ "$files" -ge 50 ]; then ok "$files files, $entry entry chunk"
  else fail "build output looks hollow ($files files, $entry entry)"; mark; fi
fi

echo
if [ $BAD -eq 0 ]; then printf "%s✓ preflight green — safe to push%s\n" "$G" "$OFF"
else printf "%s✗ preflight failed — do not push%s\n" "$R" "$OFF"; fi
exit $BAD
