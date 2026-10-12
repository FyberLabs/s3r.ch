#!/usr/bin/env bash
# Check the optional S3RCH_PANOPTICON_TENANT_ID (a marketplace tenant UUID).
# Does not print the value. An optional path argument receives the trimmed id.
# Unset or blank: exit 0, write nothing. The deploy then leaves App Service
# PANOPTICON_TENANT_ID as it is (never cleared), and the site runs without
# Panopticon integrations if that setting is also absent.
# Set but not a UUID: exit 1.
set -euo pipefail

tenant_id="$(printf '%s' "${S3RCH_PANOPTICON_TENANT_ID:-}" | tr -d '[:space:]')"

if [ -z "$tenant_id" ]; then
  echo "GitHub variable S3RCH_PANOPTICON_TENANT_ID is unset; skipping PANOPTICON_TENANT_ID."
  echo "App Service PANOPTICON_TENANT_ID is left unchanged, not cleared."
  if [ "${1:-}" != "" ]; then
    rm -f "$1"
  fi
  exit 0
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
