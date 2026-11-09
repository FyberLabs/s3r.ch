#!/usr/bin/env bash
# Registry channel and two App Services, with separate restart/health failures.
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export PATH="$tmp:$PATH" STATE="$tmp/channel" TRACE="$tmp/trace"
export GITHUB_REF=refs/heads/master GITHUB_SHA=$(printf 'a%.0s' {1..40})
export IMAGE=ghcr.io/fyberlabs/s3r.ch IMAGE_DIGEST=sha256:$(printf 'a%.0s' {1..64})
export OLD=sha256:$(printf 'b%.0s' {1..64}) PRIOR=$(printf 'b%.0s' {1..40})
cat > "$tmp/mock" <<'MOCK'
#!/usr/bin/env bash
set -eu
case "$(basename "$0"):$*" in
  'az:webapp config appsettings list '*) echo '[{"name":"S3RCH_IDENTITY_BLOB_ACCOUNT","value":"account"},{"name":"S3RCH_IDENTITY_BLOB_CONTAINER","value":"container"}]' ;;
  'az:webapp config show '*) echo "DOCKER|$IMAGE:test" ;;
  'az:webapp restart '*) echo "restart ${!#}" >> "$TRACE"; [[ "$CASE:$(cat "$STATE"):${!#}" != "restart:$IMAGE_DIGEST:s3rch-fyberlabs-peer-test" ]] ;;
  'docker:buildx imagetools inspect '*'.Manifest.Digest}}') cat "$STATE" ;;
  'docker:buildx imagetools inspect '*'.Image}}') printf '{"config":{"Labels":{"org.opencontainers.image.revision":"%s"}}}' "$PRIOR" ;;
  'docker:buildx imagetools create '*) value=${!#}; echo "${value##*@}" > "$STATE"; echo "set ${value##*@}" >> "$TRACE"; [[ "$CASE:${value##*@}" != "lost-response:$IMAGE_DIGEST" ]] ;;
  gh:*) if [[ "$CASE" == stale ]]; then echo "$PRIOR"; else echo "$GITHUB_SHA"; fi ;;
  node:*) echo "verify $2 $3" >> "$TRACE"; if [[ "$3" == "$GITHUB_SHA" ]]; then
      [[ "$(cat "$STATE")" == "$IMAGE_DIGEST" && "$CASE:$2" != "unhealthy:https://s3rch-fyberlabs-peer-test.azurewebsites.net" ]]
    else [[ "$3" == "$PRIOR" && "$(cat "$STATE")" == "$OLD" ]]; fi ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$tmp/mock"
for cmd in az docker gh node; do ln -s mock "$tmp/$cmd"; done
for CASE in healthy unhealthy restart lost-response stale repeat; do
  export CASE
  echo "$OLD" > "$STATE"
  if [[ "$CASE" == repeat ]]; then echo "$IMAGE_DIGEST" > "$STATE"; fi
  : > "$TRACE"
  rc=0
  bash scripts/deploy-test.sh || rc=$?
  case "$CASE" in
    healthy|repeat) [[ "$rc" == 0 && "$(cat "$STATE")" == "$IMAGE_DIGEST" ]]
      grep -Fxq "verify https://test.s3r.ch $GITHUB_SHA" "$TRACE"
      grep -Fxq "verify https://s3rch-fyberlabs-peer-test.azurewebsites.net $GITHUB_SHA" "$TRACE" ;;
    stale) [[ "$rc" != 0 && ! -s "$TRACE" && "$(cat "$STATE")" == "$OLD" ]] ;;
    *) [[ "$rc" != 0 && "$(cat "$STATE")" == "$OLD" ]]
      grep -Fxq "set $OLD" "$TRACE"
      grep -Fxq "verify https://test.s3r.ch $PRIOR" "$TRACE"
      grep -Fxq "verify https://s3rch-fyberlabs-peer-test.azurewebsites.net $PRIOR" "$TRACE" ;;
  esac
done
