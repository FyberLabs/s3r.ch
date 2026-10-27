#!/usr/bin/env bash
# Create or update the GitHub Release for TAG. Notes start with the image
# digest and keep the config-changes and migration sections from the template.
set -euo pipefail

: "${TAG:?}"
: "${IMAGE:?}"
: "${DIGEST:?}"
: "${VERSION:?}"
: "${MINOR:?}"

if ! printf '%s' "$DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "DIGEST must look like sha256:<64 hex characters>" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
template="${root}/.github/RELEASE_TEMPLATE.md"
grep -Fq '## Config changes' "$template"
grep -Fq '## Migration' "$template"

notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT
{
  echo "# ${TAG}"
  echo
  echo "Image: \`${IMAGE}@${DIGEST}\`"
  echo
  echo "Tags: \`${VERSION}\`, \`${MINOR}\`, \`latest\` (linux/amd64)."
  echo
  cat "$template"
} >"$notes"

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release edit "$TAG" --title "$TAG" --notes-file "$notes"
else
  gh release create "$TAG" --title "$TAG" --notes-file "$notes"
fi
