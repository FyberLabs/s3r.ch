#!/usr/bin/env bash
# Build output smoke: start the standalone server with no Panopticon or
# identity storage settings and check the core routes answer.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
port="${SMOKE_PORT:-3917}"
data="$(mktemp -d)"
log="$data/server.log"
cd .next/standalone

env -i PATH="$PATH" HOME="$data" NODE_ENV=production PORT="$port" HOSTNAME=127.0.0.1 \
  IDENTITY_SESSION_SECRET=smoke-only-identity-session-secret-0123456789 \
  GUN_FILE="$data/radata" GUN_SNAPSHOT="$data/snapshot.json" \
  node server.js >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$data"' EXIT

for _ in $(seq 1 30); do
  if curl --max-time 5 -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat "$log"; echo "server exited" >&2; exit 1; fi
  sleep 1
done

fail=0
check() {
  local path="$1" want="$2"
  local got
  got="$(curl --max-time 10 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$path")"
  if [ "$got" != "$want" ]; then
    echo "$path: expected $want, got $got" >&2
    fail=1
  else
    echo "$path: $got"
  fi
}
check /api/health 200
check /api/feed 307
check /gun 404
check /feed 200
check /feed/squad 200
check /forum 200
check /api/identity/providers 200

squad="$(curl --max-time 10 -fsS "http://127.0.0.1:$port/feed/squad")"
if ! printf '%s' "$squad" | grep -F 'This board stays in this browser' >/dev/null; then
  echo "squad must label its browser-only boundary" >&2
  fail=1
fi

health="$(curl --max-time 5 -fsS "http://127.0.0.1:$port/api/health")"
echo "$health"
echo "$health" | grep -Fq '"panopticon":{"status":"not-configured"' || { echo "panopticon should be not-configured" >&2; fail=1; }
printf '%s' "$health" | node "$script_dir/smoke-gun-health.cjs" || { echo "web should use the external peer" >&2; fail=1; }
for _ in $(seq 1 20); do
  echo "$health" | grep -Fq '"identity":{"status":"unavailable"' && break
  sleep 0.25
  health="$(curl --max-time 5 -fsS "http://127.0.0.1:$port/api/health")"
done
echo "$health" | grep -Fq '"identity":{"status":"unavailable"' || { echo "identity monitor did not check the missing production storage settings" >&2; fail=1; }

# No request on the web listener may become a graph writer.
seed_status="$(curl --max-time 10 -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port/api/seed")"
[[ "$seed_status" == 503 ]] || { echo "web seed endpoint accepted a write" >&2; exit 1; }
[[ ! -e "$data/radata" && ! -e "$data/snapshot.json" ]] || { echo "web created Gun storage" >&2; exit 1; }
if [ "$fail" -ne 0 ]; then cat "$log"; exit 1; fi

# Run the independent peer with its own data and a real Gun websocket.
peer_port=$((port + 1))
mkdir -p "$data/peer/public/feed-cache"
(
  cd "$data/peer"
  export GUN_FILE="$data/peer/radata" GUN_SNAPSHOT="$data/peer/snapshot.json"
  export SEED_SECRET="smoke-only" NODE_ENV=production PORT="$peer_port" HOSTNAME=127.0.0.1
  exec node "$OLDPWD/seed-peer.cjs"
) > "$data/peer.log" 2>&1 &
peer_pid=$!
trap 'kill "$peer_pid" "$pid" 2>/dev/null || true; rm -rf "$data"' EXIT
for _ in $(seq 1 30); do
  if curl --max-time 3 -fsS "http://127.0.0.1:$peer_port/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$peer_pid" 2>/dev/null; then cat "$data/peer.log"; exit 1; fi
  sleep 1
done
node --input-type=module - "$peer_port" <<'JS'
import assert from "node:assert/strict";
const origin = "http://127.0.0.1:" + process.argv[2];
assert.deepEqual((await (await fetch(origin + "/feed-cache/snapshot.json")).json()).items, []);
assert.equal((await fetch(origin + "/api/seed", { method: "POST" })).status, 401);
assert.equal((await fetch(origin + "/api/identity/session")).status, 404);
const socket = new WebSocket(origin.replace("http:", "ws:") + "/gun");
const timeout = setTimeout(() => { throw Error("Gun handshake timed out"); }, 5000);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
clearTimeout(timeout);
socket.close();
JS
# Two unrelated deep links must use the same prerendered shell.
node -e 'const assert = require("node:assert/strict"); const routes = require("./.next/prerender-manifest.json").routes; assert.ok(routes["/saved-view"])'
for id in first-view second-view; do
  curl --max-time 10 -fsS "http://127.0.0.1:$port/views/$id" -o "$data/$id.html"
done
