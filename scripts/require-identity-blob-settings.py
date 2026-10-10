#!/usr/bin/env python3
"""Require the App Service identity blob settings before deploy.

Reads the JSON list from `az webapp config appsettings list`. Does not print
setting values. Exits 1 when the account or container name is missing or
not a valid Azure name.
"""
import json
import re
import sys

ACCOUNT = re.compile(r"[a-z0-9]{3,24}")
CONTAINER = re.compile(r"[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: require-identity-blob-settings.py SETTINGS.json")
    with open(sys.argv[1], encoding="utf-8") as handle:
        items = json.load(handle)
    settings = {}
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and item.get("name"):
                settings[str(item["name"])] = str(item.get("value") or "").strip()
    account = settings.get("S3RCH_IDENTITY_BLOB_ACCOUNT", "")
    container = settings.get("S3RCH_IDENTITY_BLOB_CONTAINER", "")
    if ACCOUNT.fullmatch(account) is None or CONTAINER.fullmatch(container) is None:
        sys.exit(
            "Configure S3RCH_IDENTITY_BLOB_ACCOUNT and S3RCH_IDENTITY_BLOB_CONTAINER "
            "before deploying; see docs/identity-storage.md"
        )


if __name__ == "__main__":
    main()
