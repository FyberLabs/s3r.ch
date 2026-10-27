#!/usr/bin/env bash
# Fail unless IMAGE:VERSION can be pulled with no registry credentials.
# Package visibility is changed in GitHub package settings, not by this workflow.
set -euo pipefail

: "${IMAGE:?}"
: "${VERSION:?}"

if ! printf '%s' "$IMAGE" | grep -Eq '^ghcr\.io/[a-z0-9._/-]+$'; then
  echo "unexpected image name" >&2
  exit 1
fi
if ! printf '%s' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "VERSION must be X.Y.Z" >&2
  exit 1
fi

cfg="$(mktemp -d)"
trap 'rm -rf "$cfg"' EXIT
ok=0
for attempt in 1 2 3 4 5; do
  if docker --config "$cfg" pull "${IMAGE}:${VERSION}"; then
    ok=1
    break
  fi
  if [ "$attempt" -lt 5 ]; then
    sleep 5
  fi
done
if [ "$ok" -ne 1 ]; then
  echo "Anonymous pull of ${IMAGE}:${VERSION} failed." >&2
  echo "Set the GHCR package to Public in package settings, then rerun this workflow." >&2
  echo "The workflow does not change visibility and does not publish the GitHub Release until this pull works." >&2
  exit 1
fi
echo "Anonymous pull of ${IMAGE}:${VERSION} succeeded."
