#!/usr/bin/env bash
# Exercise the production entry point against a stateful App Service stand-in.
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export PATH="$tmp:$PATH" STATE="$tmp/image" TRACE="$tmp/trace"
export GITHUB_REF=refs/heads/master GITHUB_SHA=$(printf 'a%.0s' {1..40})
export IMAGE=ghcr.io/fyberlabs/s3r.ch IMAGE_DIGEST=sha256:$(printf 'a%.0s' {1..64})
export OLD=acrfybercg47.azurecr.io/s3rch@sha256:$(printf 'b%.0s' {1..64})
export NEW=acrfybercg47.azurecr.io/s3rch@$IMAGE_DIGEST PRIOR=$(printf 'b%.0s' {1..40})
cat > "$tmp/mock" <<'MOCK'
#!/usr/bin/env bash
set -eu
case "$(basename "$0"):$*" in
  'az:webapp config appsettings list '*) echo '[{"name":"S3RCH_IDENTITY_BLOB_ACCOUNT","value":"account"},{"name":"S3RCH_IDENTITY_BLOB_CONTAINER","value":"container"}]' ;;
  'az:acr import '*) ;;
  'az:acr repository show '*) echo "$IMAGE_DIGEST" ;;
  'az:webapp config show '*) echo "DOCKER|$(cat "$STATE")" ;;
  'az:webapp config container set '*)
    while [[ "$1" != --container-image-name ]]; do shift; done
    echo "$2" > "$STATE"; echo "set $2" >> "$TRACE"
    [[ "$CASE:$2" != "lost-response:$NEW" ]] ;;
  'az:webapp restart '*) echo restart >> "$TRACE"; [[ "$CASE:$(cat "$STATE")" != "restart:$NEW" ]] ;;
  curl:*) printf '{"revision":"%s"}' "$PRIOR" ;;
  gh:*) if [[ "$CASE" == stale ]]; then echo "$PRIOR"; else echo "$GITHUB_SHA"; fi ;;
  node:*) echo "verify $3" >> "$TRACE"
    if [[ "$3" == "$GITHUB_SHA" ]]; then
      [[ "$(cat "$STATE")" == "$NEW" && "$CASE" != unhealthy ]]
    else
      [[ "$3" == "$PRIOR" && "$(cat "$STATE")" == "$OLD" ]]
    fi ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$tmp/mock"
for cmd in az curl gh node; do ln -s mock "$tmp/$cmd"; done
for CASE in healthy unhealthy restart lost-response stale repeat; do
  export CASE
  echo "$OLD" > "$STATE"
  if [[ "$CASE" == repeat ]]; then echo "$NEW" > "$STATE"; fi
  : > "$TRACE"
  rc=0
  bash scripts/deploy-test.sh || rc=$?
  case "$CASE" in
    healthy|repeat) [[ "$rc" == 0 && "$(cat "$STATE")" == "$NEW" ]] ;;
    stale) [[ "$rc" != 0 && "$(cat "$STATE")" == "$OLD" ]];;
    *) [[ "$rc" != 0 && "$(cat "$STATE")" == "$OLD" ]]
       grep -Fxq "set $NEW" "$TRACE"
       grep -Fxq "set $OLD" "$TRACE"
       [[ "$(tail -1 "$TRACE")" == "verify $PRIOR" ]] ;;
  esac
  if [[ "$CASE" == repeat || "$CASE" == stale ]]; then
    if grep -Eq '^set |^restart$' "$TRACE"; then exit 1; fi
  fi
done
