#!/usr/bin/env bash
# TEST services follow the channel. Record the registry digest for deployment
# verification and recovery without changing either service's image setting.
set -euo pipefail
[[ "${GITHUB_REF:-}" == refs/heads/master ]]
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
[[ "${IMAGE_DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${IMAGE:-}" == ghcr.io/fyberlabs/s3r.ch ]]
channel="$IMAGE:test"
rollout_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/s3rch-rollout.XXXXXXXX")
trap 'rm -rf -- "$rollout_dir"' EXIT
export S3RCH_REFRESH_RUN_FILE="$rollout_dir/refresh-run"


channel_digest() {
  docker buildx imagetools inspect "$channel" --format '{{.Manifest.Digest}}'
}
set_channel() {
  docker buildx imagetools create --prefer-index=false --tag "$channel" "$IMAGE@$1"
}
refresh() {
  local digest=$1 scope
  shift
  scope=$(GH_TOKEN="${REFRESH_TOKEN:?}" DISPATCH_REVISION="$GITHUB_SHA" DISPATCH_RUN_ID="$GITHUB_RUN_ID" \
    DISPATCH_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" DISPATCH_CHANNEL_DIGEST="$digest" \
    node scripts/dispatch-static-publish.mjs refresh) || return 1
  case "$scope" in
    web-only)
      node scripts/verify-deployed-release.mjs https://test.s3r.ch "$@" --web-only
      ;;
    web-and-peer)
      node scripts/verify-deployed-release.mjs https://test.s3r.ch "$@" &&
        node scripts/verify-deployed-release.mjs https://test.s3r.ch/_peer "$@"
      ;;
    *)
      echo 'Unexpected TEST verification scope' >&2
      return 1
      ;;
  esac
}
refresh_candidate() {
  local status=0 head digest
  refresh "$IMAGE_DIGEST" "$GITHUB_SHA" "$@" || status=$?
  # The verifier reserves exit 3 for a previous TEST revision that is still serving.
  if [[ "$status" != 3 ]]; then return "$status"; fi
  head=$(gh api repos/FyberLabs/s3r.ch/branches/master --jq .commit.sha) || return 1
  digest=$(channel_digest) || return 1
  if [[ "$head" != "$GITHUB_SHA" || "$digest" != "$IMAGE_DIGEST" ]]; then
    echo 'TEST candidate lost the rollout before its refresh retry.' >&2
    return 1
  fi
  echo 'Previous TEST revision is still serving. Refreshing the moving TEST channel once.'
  refresh "$IMAGE_DIGEST" "$GITHUB_SHA" "$@"
}
previous=$(channel_digest)
[[ "$previous" =~ ^sha256:[0-9a-f]{64}$ ]]
head=$(gh api repos/FyberLabs/s3r.ch/branches/master --jq .commit.sha)
[[ "$head" == "$GITHUB_SHA" ]] || { echo 'Superseded TEST deployment' >&2; exit 1; }
if [[ "$previous" == "$IMAGE_DIGEST" ]]; then
  refresh_candidate
  exit
fi
prior_revision=$(docker buildx imagetools inspect "$IMAGE@$previous" --format '{{json .Image}}' |
  python3 -c 'import json,sys; doc=json.load(sys.stdin); cfg=doc.get("linux/amd64",doc); print(cfg["config"]["Labels"]["org.opencontainers.image.revision"])')
[[ "$prior_revision" =~ ^[0-9a-f]{40}$ ]]
if set_channel "$IMAGE_DIGEST" && [[ "$(channel_digest)" == "$IMAGE_DIGEST" ]] && refresh_candidate "$prior_revision"; then
  exit 0
fi
candidate_refresh=$(cat "$S3RCH_REFRESH_RUN_FILE" 2>/dev/null || true)
current=$(channel_digest)
if [[ "$current" == "$IMAGE_DIGEST" ]]; then
  set_channel "$previous"
elif [[ "$current" != "$previous" ]]; then
  echo 'TEST channel changed independently. Leaving it in place.' >&2
  exit 1
fi
[[ "$(channel_digest)" == "$previous" ]]
refresh "$previous" "$prior_revision"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  startup='{}'
  if [[ "$candidate_refresh" =~ ^[1-9][0-9]{0,18}$ ]] &&
    GH_TOKEN="$REFRESH_TOKEN" gh run download "$candidate_refresh" -R FyberLabs/infra \
      -n s3rch-startup-config -D "$rollout_dir/startup" >/dev/null 2>&1; then
    startup=$(jq -c --arg revision "$GITHUB_SHA" 'select(.revision == $revision) |
      {revision, observed, missing, squad_key}' "$rollout_dir"/startup/*.json 2>/dev/null || echo '{}')
  fi
  if [[ -z "$startup" ]]; then startup='{}'; fi
  printf 'rollback_revision=%s\nstartup_diagnostics=%s\n' "$prior_revision" "$startup" >> "$GITHUB_OUTPUT"
fi
echo 'Restored previous TEST channel after deployment failure.' >&2
exit 1
