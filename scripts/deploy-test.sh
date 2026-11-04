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
az webapp config container set --name "$app" --resource-group "$rg" --container-image-name "$acr.azurecr.io/$repository@$IMAGE_DIGEST" --output none
az webapp restart --name "$app" --resource-group "$rg"
# Exact revision plus healthy Gun and durable identity, not merely an HTTP 200.
node scripts/verify-deployed-release.mjs https://test.s3r.ch "$GITHUB_SHA"
