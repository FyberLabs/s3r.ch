#!/usr/bin/env bash
# Fail if committed files use internal agent-ops language.
set -euo pipefail
cd "$(dirname "$0")/.."
pattern='Research Bot|Developer Bot|Soft Soft|Fast-Grok|Ready-to-Paste|Cursor Composer|If you are an AI|chris@192\.168\.6\.50'
matches="$(git grep -nE "$pattern" -- \
  ':!scripts/check-public-voice.sh' \
  ':!**/node_modules/**' \
  || true)"
if [ -n "$matches" ]; then
  printf '%s\n' "$matches"
  echo "Public voice check failed. Use descriptive English; do not name internal agents or lab SSH." >&2
  exit 1
fi
echo "Public voice check passed."
