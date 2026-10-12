#!/usr/bin/env bash
# Build output smoke: start the standalone server with no Panopticon or
# identity storage settings and check the core routes answer.
set -euo pipefail

port="${SMOKE_PORT:-3917}"
data="$(mktemp -d)"
log="$data/server.log"
cd .next/standalone

env -i PATH="$PATH" HOME="$data" NODE_ENV=production PORT="$port" HOSTNAME=127.0.0.1 \
  IDENTITY_SESSION_SECRET=smoke-only-identity-session-secret-0123456789 \
  GUN_FILE="$data/radata" GUN_SNAPSHOT="$data/snapshot.json" \
  node -r ./gun-preload.cjs server.js >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$data"' EXIT

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat "$log"; echo "server exited" >&2; exit 1; fi
  sleep 1
done

fail=0
check() {
  local path="$1" want="$2"
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$path")"
  if [ "$got" != "$want" ]; then
    echo "$path: expected $want, got $got" >&2
    fail=1
  else
    echo "$path: $got"
  fi
}
check /api/health 200
check /api/feed 200
check /feed 200
check /forum 200
check /api/identity/providers 200

health="$(curl -fsS "http://127.0.0.1:$port/api/health")"
echo "$health"
echo "$health" | grep -Fq '"panopticon":{"status":"not-configured"' || { echo "panopticon should be not-configured" >&2; fail=1; }
echo "$health" | grep -Fq '"gun":{"status":"ok"}' || { echo "gun peer should be attached" >&2; fail=1; }

if [ "$fail" -ne 0 ]; then cat "$log"; exit 1; fi
