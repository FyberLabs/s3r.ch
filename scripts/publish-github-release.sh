#!/usr/bin/env bash
# Create or update the GitHub Release for TAG. Notes start with the image
# digest and keep the config-changes and migration sections from the template.
set -euo pipefail

: "${TAG:?}"
: "${IMAGE:?}"
: "${DIGEST:?}"
: "${VERSION:?}"
: "${MINOR:?}"
: "${MINOR_MOVED:?}"
: "${LATEST_MOVED:?}"

if ! printf '%s' "$DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "DIGEST must look like sha256:<64 hex characters>" >&2
  exit 1
fi
case "$MINOR_MOVED" in
  yes|no) ;;
  *) echo "MINOR_MOVED must be yes or no" >&2; exit 1 ;;
esac
case "$LATEST_MOVED" in
  yes|no) ;;
  *) echo "LATEST_MOVED must be yes or no" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
template="${TEMPLATE:-${root}/.github/RELEASE_TEMPLATE.md}"
if [ ! -f "$template" ]; then
  echo "Release notes template is missing." >&2
  exit 1
fi
grep -Fq '## Config changes' "$template"
grep -Fq '## Migration' "$template"

notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT
{
  echo "# ${TAG}"
  echo
  echo "Image: \`${IMAGE}@${DIGEST}\`"
  echo
  tags="\`${VERSION}\`"
  if [ "$MINOR_MOVED" = "yes" ]; then
    tags="${tags}, \`${MINOR}\`"
  fi
  if [ "$LATEST_MOVED" = "yes" ]; then
    tags="${tags}, \`latest\`"
  fi
  echo "Tags: ${tags} (linux/amd64)."
  if [ "$MINOR_MOVED" != "yes" ]; then
    echo
    echo "\`${MINOR}\` was left unchanged because this version is older than that alias."
  fi
  if [ "$LATEST_MOVED" != "yes" ]; then
    echo
    echo "\`latest\` was left unchanged because this version is older than that alias."
  fi
  echo
  cat "$template"
} >"$notes"

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release edit "$TAG" --title "$TAG" --notes-file "$notes"
else
  gh release create "$TAG" --title "$TAG" --notes-file "$notes"
fi
