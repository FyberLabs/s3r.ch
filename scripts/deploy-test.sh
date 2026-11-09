#!/usr/bin/env bash
# TEST services follow the channel. Record the registry digest for deployment
# verification and recovery without changing either service's image setting.
set -euo pipefail
[[ "${GITHUB_REF:-}" == refs/heads/master ]]
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
[[ "${IMAGE_DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${IMAGE:-}" == ghcr.io/fyberlabs/s3r.ch ]]
channel="$IMAGE:test"
group=rg-s3rch-fyberlabs-prod
web=s3rch-fyberlabs-test
peer=s3rch-fyberlabs-peer-test
settings=$(mktemp)
trap 'rm -f "$settings"' EXIT
az webapp config appsettings list --name "$web" --resource-group "$group" --query "[?name=='S3RCH_IDENTITY_BLOB_ACCOUNT' || name=='S3RCH_IDENTITY_BLOB_CONTAINER']" -o json > "$settings"
python3 scripts/require-identity-blob-settings.py "$settings"

channel_digest() {
  docker buildx imagetools inspect "$channel" --format '{{.Manifest.Digest}}'
}
set_channel() {
  docker buildx imagetools create --prefer-index=false --tag "$channel" "$IMAGE@$1"
}
refresh() {
  az webapp restart -g "$group" -n "$web" &&
    az webapp restart -g "$group" -n "$peer" &&
    node scripts/verify-deployed-release.mjs https://test.s3r.ch "$1" &&
    node scripts/verify-deployed-release.mjs https://s3rch-fyberlabs-peer-test.azurewebsites.net "$1"
}
for app in "$web" "$peer"; do
  configured=$(az webapp config show -g "$group" -n "$app" --query linuxFxVersion -o tsv)
  [[ "$configured" == "DOCKER|$channel" ]] || { echo "$app must follow $channel" >&2; exit 1; }
done
previous=$(channel_digest)
[[ "$previous" =~ ^sha256:[0-9a-f]{64}$ ]]
head=$(gh api repos/FyberLabs/s3r.ch/branches/master --jq .commit.sha)
[[ "$head" == "$GITHUB_SHA" ]] || { echo 'Superseded TEST deployment' >&2; exit 1; }
if [[ "$previous" == "$IMAGE_DIGEST" ]]; then
  refresh "$GITHUB_SHA"
  exit
fi
prior_revision=$(docker buildx imagetools inspect "$IMAGE@$previous" --format '{{json .Image}}' |
  python3 -c 'import json,sys; doc=json.load(sys.stdin); cfg=doc.get("linux/amd64",doc); print(cfg["config"]["Labels"]["org.opencontainers.image.revision"])')
[[ "$prior_revision" =~ ^[0-9a-f]{40}$ ]]
if set_channel "$IMAGE_DIGEST" && [[ "$(channel_digest)" == "$IMAGE_DIGEST" ]] && refresh "$GITHUB_SHA"; then
  exit 0
fi
current=$(channel_digest)
if [[ "$current" == "$IMAGE_DIGEST" ]]; then
  set_channel "$previous"
elif [[ "$current" != "$previous" ]]; then
  echo 'TEST channel changed independently. Leaving it in place.' >&2
  exit 1
fi
[[ "$(channel_digest)" == "$previous" ]]
refresh "$prior_revision"
echo 'Restored previous TEST channel after deployment failure.' >&2
exit 1
