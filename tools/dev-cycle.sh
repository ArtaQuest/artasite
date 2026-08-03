#!/usr/bin/env bash
#
# ArtaQuest dev cycle — one command to validate the whole question-first stack.
#
#   tools/dev-cycle.sh            # full: typecheck + build + backend assertions + browser smoke
#   tools/dev-cycle.sh --backend  # skip the frontend build + browser smoke (fast inner loop)
#   tools/dev-cycle.sh --no-build  # run tests against the already-built app
#
# Exit code 0 = all green. Each stage prints a clear PASS/FAIL; the run stops at the first failure.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
step() { printf "\n${BOLD}▶ %s${OFF}\n" "$1"; }
die()  { printf "${RED}✗ %s${OFF}\n" "$1"; exit 1; }
oky()  { printf "${GREEN}✓ %s${OFF}\n" "$1"; }

MODE="${1:-full}"

# ── 1. Frontend typecheck + build ──────────────────────────────────────────
if [[ "$MODE" != "--backend" && "$MODE" != "--no-build" ]]; then
  step "1/4  Frontend typecheck + build"
  ( cd artaquest-web && npx tsc --noEmit ) || die "tsc failed"
  ( cd artaquest-web && npm run build >/dev/null 2>&1 ) || die "vite build failed"
  oky "tsc clean + bundle built"
else
  printf "${DIM}↷ skipping frontend build (%s)${OFF}\n" "$MODE"
fi

# ── 2. Backend assertion harness (the source of truth for the model) ───────
step "2/4  Backend model assertions (studio wp eval)"
BLOG="$(mktemp)"
studio wp eval 'require WP_PLUGIN_DIR . "/aquest/tools/test-model.php";' 2>&1 | tee "$BLOG"
grep -q "AQ_TEST_RESULT=GREEN" "$BLOG" || die "backend assertions RED — see output above"
oky "backend assertions green"

# ── 3. Browser smoke (real UI through the persistent Chrome) ───────────────
if [[ "$MODE" != "--backend" ]]; then
  step "3/4  Browser smoke (persistent Chrome / CDP)"
  WLOG="$(mktemp)"
  node tools/browser-smoke.mjs 2>&1 | tee "$WLOG"
  if grep -q "AQ_BROWSER_RESULT=RED" "$WLOG"; then die "browser smoke RED — see output above"; fi
  if grep -q "AQ_BROWSER_RESULT=SKIP" "$WLOG"; then printf "${DIM}↷ browser smoke skipped (no Chrome on :9222)${OFF}\n"; else oky "browser smoke green"; fi

  # ── 4. Clean up the admin question the smoke test created ────────────────
  step "4/4  Cleanup (smoke-test data)"
  studio wp eval '
    global $wpdb;$p=$wpdb->prefix;
    $admin=(int)$wpdb->get_var("SELECT ID FROM {$p}users WHERE user_login=\"admin\" LIMIT 1");
    if($admin){ $wpdb->query($wpdb->prepare("DELETE FROM {$p}aq_section_comments WHERE user_id=%d",$admin));
                $wpdb->query($wpdb->prepare("DELETE FROM {$p}aq_section_votes WHERE voter_id=%d",$admin)); }
    echo "cleaned admin smoke data\n";' >/dev/null 2>&1 && oky "smoke data cleaned"
else
  printf "${DIM}↷ skipping browser smoke (--backend)${OFF}\n"
fi

printf "\n${GREEN}${BOLD}ALL GREEN${OFF} — the question-first model is healthy.\n"
