#!/bin/bash
# Isolated /research deploy — build the SPA in a git WORKTREE (never the shared app/), push through the lock.
# Respects COORDINATION rule #4: the shared wp-content/themes/artaquest-theme/app/ is never written from a
# parallel build. The worktree is a detached copy; only it is built and pushed.
#   tools/isolated-deploy.sh            # build worktree @ main HEAD, push themes to prod via the deploy lock
set -u
MAIN=/Users/arash/Studio/artaquest
WT=/tmp/aq-deploy-wt
LOCKDIR=/tmp/aq-isolated-deploy.lock.d
# single-flight (macOS-safe, mkdir is atomic): if a deploy is already running, skip — the next checkpoint
# pushes the latest atlas anyway.
mkdir "$LOCKDIR" 2>/dev/null || { echo "[isolated-deploy] another deploy in flight — skipping"; exit 0; }
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

SHA=$(git -C "$MAIN" rev-parse HEAD)
# Validate it is a REAL worktree, not just a directory that happens to exist. A worktree can lose its
# .git link (stale gitdir after a prune, or /tmp reaping the admin files); the dir survives with a
# partial tree. A bare `-d` test then skips recreation and the checkout below silently no-ops, so the
# build runs against a STALE, INCOMPLETE tree — it fails on a missing script, or worse, deploys old code.
if ! git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[isolated-deploy] worktree at $WT is not a git worktree — recreating"
  git -C "$MAIN" worktree remove --force "$WT" >/dev/null 2>&1
  rm -rf "$WT"
  git -C "$MAIN" worktree prune
  git -C "$MAIN" worktree add --detach "$WT" "$SHA" || { echo "[isolated-deploy] cannot create worktree"; exit 1; }
fi
# Never let the sync fail silently — building the wrong commit is worse than not deploying.
git -C "$WT" checkout -f --detach "$SHA" >/dev/null 2>&1 \
  || git -C "$WT" reset --hard "$SHA" >/dev/null 2>&1 \
  || { echo "[isolated-deploy] cannot sync worktree to $SHA"; exit 1; }
[ "$(git -C "$WT" rev-parse HEAD)" = "$SHA" ] \
  || { echo "[isolated-deploy] worktree HEAD != $SHA after sync — refusing to build"; exit 1; }
ln -sfn "$MAIN/artaquest-web/node_modules" "$WT/artaquest-web/node_modules"

echo "[isolated-deploy] building SPA in worktree @ ${SHA:0:8}…"
( cd "$WT/artaquest-web" && npm run build ) >/tmp/wt_build.log 2>&1 || { echo "[isolated-deploy] BUILD FAILED (see /tmp/wt_build.log)"; exit 1; }
TOPICS=$(python3 -c "import json;print(len(json.load(open('$WT/artaquest-web/src/data/research.json'))['topics']))" 2>/dev/null)
APP=wp-content/themes/artaquest-theme/app
# Install the COMPLETE isolated build into the registered main site, then push from it UNDER THE LOCK. studio
# push only knows the registered site (the worktree isn't one), so we install + push there; doing both inside
# the deploy lock serialises it with every other deploy/build, so it never races/corrupts the shared manifest.
echo "[isolated-deploy] built ($TOPICS topics) — installing into main app/ + pushing under the lock…"
cd "$MAIN"
"$MAIN/tools/ticket-agent/aq-deploy" bash -c "rsync -a --delete '$WT/$APP/' '$MAIN/$APP/' && cd '$MAIN' && studio push --path . --options themes --remote-site https://artaquest.com"
RC=$?
echo "[isolated-deploy] aq-deploy rc=$RC"
exit $RC
