#!/usr/bin/env bash
#
# vendor-names-gate — fail if an AI vendor or model name appears anywhere in the tracked tree
# outside tools/vendor-names-allow.txt. The platform's assistant is Arta, and its other AI features
# go by ArtaQuest's own names; which provider runs underneath is configuration, not copy.
#
#   tools/vendor-names-gate.sh        # exit 0 = clean
#
# Matches case-insensitively at a word START, so "ClaudeBot" and "xAI" are caught while
# "philanthropic" is not. Binary files are skipped (git grep -I).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PAT='\b(claude|anthropic|grok|xai)'
ALLOW="tools/vendor-names-allow.txt"

hits=$(git grep -n -I -i -E "$PAT" -- . ':!node_modules' 2>/dev/null || true)
# Untracked-but-not-ignored files count too, so a new file is gated before its first commit.
untracked=$(git ls-files --others --exclude-standard)
if [ -n "$untracked" ]; then
  extra=$(printf '%s\n' "$untracked" | while IFS= read -r f; do
    [ -f "$f" ] && grep -I -n -i -E "$PAT" "$f" 2>/dev/null | sed "s#^#$f:#"
  done)
  [ -n "$extra" ] && hits=$(printf '%s\n%s' "$hits" "$extra")
fi

bad=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  path=${line%%:*}; rest=${line#*:}; text=${rest#*:}
  allowed=0
  while IFS=$'\t' read -r apath apat; do
    case "$apath" in ''|'#'*) continue ;; esac
    if [ "$apath" = "$path" ] && printf '%s' "$text" | grep -q -E -- "$apat"; then allowed=1; break; fi
  done < "$ALLOW"
  if [ "$allowed" = 0 ]; then
    printf '  %s\n' "$(printf '%s' "$line" | cut -c1-200)"
    bad=$((bad + 1))
  fi
done <<< "$hits"

if [ "$bad" -gt 0 ]; then
  echo "vendor-names-gate: $bad line(s) name an AI vendor or model outside $ALLOW"
  exit 1
fi
echo "no AI vendor or model names outside the allow-list"
