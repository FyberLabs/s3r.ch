#!/usr/bin/env bash
set -euo pipefail
data=$(mktemp -d)
port=${SIGN_IN_TEST_PORT:-3987}
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf "$data"
}
trap cleanup EXIT
env -i PATH="$PATH" HOME="$data" NEXT_TELEMETRY_DISABLED=1 \
  S3RCH_SESSION_SIGNING_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" \
  S3RCH_MEDIA_SIGNING_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" \
  S3RCH_IDENTITY_LINKS="$data/identity.json" \
  node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port "$port" >"$data/server.log" 2>&1 &
pid=$!
for _ in {1..90}; do
  kill -0 "$pid"
  if curl -fsS --max-time 3 "http://127.0.0.1:$port/api/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
node --import tsx scripts/test-proxied-sign-in.ts "$port"