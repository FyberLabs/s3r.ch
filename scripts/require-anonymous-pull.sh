#!/usr/bin/env bash
# Pull and boot the exact published digest with no registry credentials.
# Package visibility is changed in GitHub package settings, not by this workflow.
set -euo pipefail

: "${IMAGE:?}"
: "${VERSION:?}"
: "${DIGEST:?}"

expected="ghcr.io/$(printf '%s' "${GITHUB_REPOSITORY:-}" | tr '[:upper:]' '[:lower:]')"
if [ "$IMAGE" != "$expected" ]; then
  echo "unexpected image name" >&2
  exit 1
fi
if ! printf '%s' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "VERSION must be X.Y.Z" >&2
  exit 1
fi

if ! printf '%s' "$DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "DIGEST must look like sha256:<64 hex characters>" >&2
  exit 1
fi
reference="${IMAGE}@${DIGEST}"
cfg="$(mktemp -d)"
trap 'rm -rf "$cfg"' EXIT
ok=0
for attempt in 1 2 3 4 5; do
  if docker --config "$cfg" pull "$reference"; then
    ok=1
    break
  fi
  if [ "$attempt" -lt 5 ]; then
    sleep 5
  fi
done
if [ "$ok" -ne 1 ]; then
  echo "Anonymous pull of ${reference} failed." >&2
  echo "Set the GHCR package to Public in package settings, then rerun this workflow." >&2
  echo "The workflow does not change visibility and does not publish the GitHub Release until this pull works." >&2
  exit 1
fi
echo "Anonymous pull of ${reference} succeeded."

# Reruns can reuse an older published artifact instead of this run's rebuild.
# Validate the artifact the release and aliases will actually advertise.
root="$(cd "$(dirname "$0")/.." && pwd)"
bash "$root/scripts/smoke-image.sh" "$reference"
