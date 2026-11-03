#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Local emulator credentials only; no Azure account or deployment configuration.
key="$(node -e 'process.stdout.write(Buffer.alloc(32, 7).toString("base64"))')"
container="$(docker run -d --rm -p 127.0.0.1::10000 \
  -e "AZURITE_ACCOUNTS=outboxtest:${key}" \
  mcr.microsoft.com/azure-storage/azurite:3.35.0@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37 \
  azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck --silent)"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
port="$(docker port "$container" 10000/tcp | sed -n 's/^127\.0\.0\.1://p')"
[[ "$port" =~ ^[0-9]+$ ]]
node node_modules/tsx/dist/cli.mjs scripts/test-delegation-blob.ts "$port" write
docker restart "$container" >/dev/null
port="$(docker port "$container" 10000/tcp | sed -n 's/^127\.0\.0\.1://p')"
[[ "$port" =~ ^[0-9]+$ ]]
node node_modules/tsx/dist/cli.mjs scripts/test-delegation-blob.ts "$port" read
