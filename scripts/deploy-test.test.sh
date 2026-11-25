#!/usr/bin/env bash
# Registry channel and two App Services, with separate restart/health failures.
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export PATH="$tmp:$PATH" STATE="$tmp/channel" TRACE="$tmp/trace"
export GITHUB_REF=refs/heads/master GITHUB_SHA=$(printf 'a%.0s' {1..40})
export GITHUB_RUN_ID=123 GITHUB_RUN_ATTEMPT=1 REFRESH_TOKEN=mock-refresh-token
export IMAGE=ghcr.io/fyberlabs/s3r.ch IMAGE_DIGEST=sha256:$(printf 'a%.0s' {1..64})
export OTHER=sha256:$(printf 'c%.0s' {1..64})
export OLD=sha256:$(printf 'b%.0s' {1..64}) PRIOR=$(printf 'b%.0s' {1..40})
cat > "$tmp/mock" <<'MOCK'
#!/usr/bin/env bash
set -eu
case "$(basename "$0"):$*" in
  'node:scripts/dispatch-static-publish.mjs refresh')
    [[ "$GH_TOKEN" == "$REFRESH_TOKEN" && "$DISPATCH_CHANNEL_DIGEST" == "$(cat "$STATE")" ]] || exit 2
    echo "refresh $DISPATCH_CHANNEL_DIGEST" >> "$TRACE"
    [[ "$CASE:$DISPATCH_CHANNEL_DIGEST" != "restart:$IMAGE_DIGEST" ]] || exit 1
    if [[ "$CASE" == web-only ]]; then echo web-only; else echo web-and-peer; fi ;;
  'docker:buildx imagetools inspect '*'.Manifest.Digest}}') cat "$STATE" ;;
  'docker:buildx imagetools inspect '*'.Image}}') printf '{"config":{"Labels":{"org.opencontainers.image.revision":"%s"}}}' "$PRIOR" ;;
  'docker:buildx imagetools create '*) value=${!#}; echo "${value##*@}" > "$STATE"; echo "set ${value##*@}" >> "$TRACE"; [[ "$CASE:${value##*@}" != "lost-response:$IMAGE_DIGEST" ]] ;;
  gh:*)
    if [[ "$CASE" == stale ]] || { [[ "$CASE" == superseded ]] && [[ -s "$TRACE" ]]; }; then
      echo "$PRIOR"
    else
      echo "$GITHUB_SHA"
    fi ;;
  node:*) echo "verify $2 $3" >> "$TRACE"; if [[ "$3" == "$GITHUB_SHA" ]]; then
      if [[ "$CASE" == repeat ]]; then [[ -z "${4:-}" ]] || exit 2
      else [[ "${4:-}" == "$PRIOR" ]] || exit 2
      fi
      if [[ "$2" == https://test.s3r.ch ]]; then
        case "$CASE" in
          stale-once|superseded)
            if [[ $(grep -Fxc "verify $2 $3" "$TRACE") == 1 ]]; then exit 3; fi ;;
          stale-twice) exit 3 ;;
          channel-moved) echo "$OTHER" > "$STATE"; exit 3 ;;
        esac
      fi
      [[ "$(cat "$STATE")" == "$IMAGE_DIGEST" && "$CASE:$2" != "unhealthy:https://test.s3r.ch/_peer" ]] || exit 1
      if [[ "$CASE" == web-only ]]; then [[ "$2" == https://test.s3r.ch && "${5:-}" == --web-only ]]; fi
    else [[ "$3" == "$PRIOR" && -z "${4:-}" && "$(cat "$STATE")" == "$OLD" ]]; fi ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$tmp/mock"
for cmd in docker gh node; do ln -s mock "$tmp/$cmd"; done
for CASE in healthy web-only unhealthy restart lost-response stale repeat stale-once stale-twice superseded channel-moved; do
  export CASE
  echo "$OLD" > "$STATE"
  if [[ "$CASE" == repeat ]]; then echo "$IMAGE_DIGEST" > "$STATE"; fi
  : > "$TRACE"
  rc=0
  bash scripts/deploy-test.sh || rc=$?
  case "$CASE" in
    healthy|repeat|stale-once) [[ "$rc" == 0 && "$(cat "$STATE")" == "$IMAGE_DIGEST" ]]
      grep -Fxq "verify https://test.s3r.ch $GITHUB_SHA" "$TRACE"
      grep -Fxq "verify https://test.s3r.ch/_peer $GITHUB_SHA" "$TRACE" ;;
    web-only) [[ "$rc" == 0 && "$(cat "$STATE")" == "$IMAGE_DIGEST" ]]
      grep -Fxq "verify https://test.s3r.ch $GITHUB_SHA" "$TRACE"
      ! grep -q '/_peer' "$TRACE" ;;
    stale) [[ "$rc" != 0 && ! -s "$TRACE" && "$(cat "$STATE")" == "$OLD" ]] ;;
    channel-moved) [[ "$rc" != 0 && "$(cat "$STATE")" == "$OTHER" ]]
      ! grep -Fxq "set $OLD" "$TRACE" ;;
    *) [[ "$rc" != 0 && "$(cat "$STATE")" == "$OLD" ]]
      grep -Fxq "set $OLD" "$TRACE"
      grep -Fxq "verify https://test.s3r.ch $PRIOR" "$TRACE"
      grep -Fxq "verify https://test.s3r.ch/_peer $PRIOR" "$TRACE" ;;
  esac
  expected_attempts=1
  case "$CASE" in
    stale|restart|lost-response) expected_attempts=0 ;;
    stale-once|stale-twice) expected_attempts=2 ;;
  esac
  attempts=$(awk -v expected="verify https://test.s3r.ch $GITHUB_SHA" '$0 == expected { count++ } END { print count+0 }' "$TRACE")
  [[ "$attempts" == "$expected_attempts" ]]
done
