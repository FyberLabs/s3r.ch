#!/usr/bin/env bash
# Confirm S3RCH_PANOPTICON_TENANT_ID is a marketplace tenant UUID.
# Does not print the value. An optional path argument receives the trimmed id.
# Exit 1 when the variable is unset or not a UUID so deploy cannot clear
# App Service PANOPTICON_TENANT_ID.
set -euo pipefail

tenant_id="$(printf '%s' "${S3RCH_PANOPTICON_TENANT_ID:-}" | tr -d '[:space:]')"

if [ -z "$tenant_id" ]; then
  echo "GitHub variable S3RCH_PANOPTICON_TENANT_ID is unset." >&2
  echo "Create it on this repository or the prod environment before deploy." >&2
  echo "Refusing to update App Service so PANOPTICON_TENANT_ID is not cleared." >&2
  exit 1
fi

if ! printf '%s' "$tenant_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
  echo "GitHub variable S3RCH_PANOPTICON_TENANT_ID is not a UUID." >&2
  echo "Refusing to update App Service PANOPTICON_TENANT_ID." >&2
  exit 1
fi

if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::${tenant_id}"
fi

if [ "${1:-}" != "" ]; then
  umask 077
  printf '%s' "$tenant_id" >"$1"
fi
