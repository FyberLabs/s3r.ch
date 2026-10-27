#!/usr/bin/env bash
# Boot a local image with no Panopticon settings.
# GET /api/health must return 200, and packages required outside Next.js
# (including viem) must resolve inside the image.
set -euo pipefail

image="${1:?usage: scripts/smoke-image.sh <image>}"
port="${SMOKE_PORT:-3921}"
name="s3rch-smoke-$$"
root="$(cd "$(dirname "$0")/.." && pwd)"
secret="smoke-only-identity-session-secret-0123456789"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

user="$(docker image inspect --format '{{.Config.User}}' "$image")"
if [ "$user" != "nextjs" ]; then
  echo "image user is ${user}, expected nextjs" >&2
  exit 1
fi

uid="$(docker run --rm --entrypoint id "$image" -u | tr -d '\r')"
printf '%s\n' "$uid"
if [ "$uid" != "1001" ]; then
  echo "expected uid 1001, got ${uid}" >&2
  exit 1
fi

mapfile -t packages < <(node "$root/scripts/startup-packages.mjs")
if [ "${#packages[@]}" -eq 0 ]; then
  echo "startup package list is empty" >&2
  exit 1
fi
printf '%s\n' "${packages[@]}" | grep -qx 'viem'
printf '%s\n' "${packages[@]}" | grep -qx 'gun'

for pkg in "${packages[@]}"; do
  if ! printf '%s' "$pkg" | grep -Eq '^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$'; then
    echo "refusing package name ${pkg}" >&2
    exit 1
  fi
  docker run --rm --entrypoint node "$image" -e "require.resolve('${pkg}')" >/dev/null
  echo "present ${pkg}"
done

docker run -d --name "$name" -p "127.0.0.1:${port}:8080" \
  -e "IDENTITY_SESSION_SECRET=${secret}" \
  "$image" >/dev/null

# The image must not carry Panopticon configuration.
docker exec "$name" node -e 'const keys=Object.keys(process.env).filter((key)=>key.startsWith("PANOPTICON_")); if (keys.length) { console.error(keys.join(" ")); process.exit(1); }'

for _ in $(seq 1 40); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" != "true" ]; then
    echo "container exited before health" >&2
    docker logs "$name" || true
    exit 1
  fi
  if body="$(curl --max-time 5 -fsS "http://127.0.0.1:${port}/api/health" 2>/dev/null)"; then
    printf '%s\n' "$body"
    printf '%s\n' "$body" | grep -Fq '"status":"ok"'
    printf '%s\n' "$body" | grep -Fq '"panopticon":{"status":"not-configured"'
    printf '%s\n' "$body" | grep -Fq '"gun":{"status":"ok"'
    echo "image smoke passed"
    exit 0
  fi
  sleep 2
done

echo "GET /api/health did not return 200" >&2
docker logs "$name" || true
exit 1
