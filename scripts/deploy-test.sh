#!/usr/bin/env bash
# Fixed test destination. Production is selected by infra from stable releases.
set -euo pipefail
[[ "${GITHUB_REF:-}" == refs/heads/master ]]
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
[[ "${IMAGE_DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${IMAGE:-}" == ghcr.io/fyberlabs/s3r.ch ]]
acr=acrfybercg47
repository=s3rch
app=s3rch-fyberlabs-test
rg=rg-s3rch-fyberlabs-prod
settings="$(mktemp)"
trap 'rm -f "$settings"' EXIT
az webapp config appsettings list --name "$app" --resource-group "$rg" --query "[?name=='S3RCH_IDENTITY_BLOB_ACCOUNT' || name=='S3RCH_IDENTITY_BLOB_CONTAINER']" -o json > "$settings"
python3 scripts/require-identity-blob-settings.py "$settings"
az acr import --name "$acr" --source "$IMAGE@$IMAGE_DIGEST" --image "$repository:sha-$GITHUB_SHA" --force --output none
imported="$(az acr repository show --name "$acr" --image "$repository:sha-$GITHUB_SHA" --query digest -o tsv)"
[[ "$imported" == "$IMAGE_DIGEST" ]] || { echo 'Import changed the tested digest' >&2; exit 1; }
candidate="$acr.azurecr.io/$repository@$IMAGE_DIGEST"
origin=https://test.s3r.ch
site=(--name "$app" --resource-group "$rg")
configured_image() {
  az webapp config show "${site[@]}" --query linuxFxVersion -o tsv
}
set_image() {
  az webapp config container set "${site[@]}" --container-image-name "$1" --output none
}
verify() {
  node scripts/verify-deployed-release.mjs "$origin" "$1"
}
previous=$(configured_image)
previous=${previous#DOCKER|}
[[ "${previous%@*}" == "$acr.azurecr.io/$repository" && "${previous##*@}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "Cannot establish an immutable rollback image" >&2
  exit 1
}
if [[ "$previous" != "$candidate" ]]; then
  prior_revision=$(curl --fail --silent --show-error --max-time 15 "$origin/api/version" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])')
  verify "$prior_revision"
fi
head=$(gh api repos/FyberLabs/s3r.ch/branches/master --jq .commit.sha)
[[ "$head" == "$GITHUB_SHA" ]] || { echo "Superseded TEST deployment" >&2; exit 1; }
if [[ "$previous" == "$candidate" ]]; then
  verify "$GITHUB_SHA"
  exit
fi
[[ "$(configured_image)" == "DOCKER|$previous" ]]
if set_image "$candidate" && az webapp restart "${site[@]}" && verify "$GITHUB_SHA"; then
  exit 0
fi

# Azure may commit a configuration change even if its response is lost.
current=$(configured_image)
if [[ "$current" == "DOCKER|$candidate" ]]; then
  echo "Candidate failed. Restoring $previous" >&2
  set_image "$previous"
  az webapp restart "${site[@]}"
elif [[ "$current" != "DOCKER|$previous" ]]; then
  echo "Image changed independently. Check TEST before retrying." >&2
  exit 1
fi
[[ "$(configured_image)" == "DOCKER|$previous" ]]
verify "$prior_revision"
echo "Previous TEST deployment verified. Candidate deployment failed." >&2
exit 1
