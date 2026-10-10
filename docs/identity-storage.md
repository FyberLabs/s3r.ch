# Durable account-link storage

Account links are account data. They must survive a new container and an App
Service recycle. The preferred home is a control-plane account service. No such
API exists on the Panopticon routes this app already calls, so production stores
the same JSON document in one private Azure Blob behind `LinkStore`.
`BlobLinkStore` is that adapter. Development and tests keep `FileLinkStore`.
A later account API can replace the class without changing link rules.

These are the routes checked:

- TURN allocate, oracles attest, and payments receipt/intent (`PANOPTICON_TURN_BASE`, `PANOPTICON_ORACLES_BASE`, `PANOPTICON_PAYMENTS_BASE`, plus the shared tenant id and API key). They allocate relays, attestations, and payment receipts. They do not read or write an account link.
- `GET /auth/siwe/me` and `POST /auth/siwe/bind`. They bind one wallet to the Keycloak subject of a bearer token. This app does not keep that token, a wallet-only sign-in has no Keycloak subject, and the record is one address per subject rather than the handles on one checksummed owner.
- User-service organization identity-provider links. They bind an enterprise organization after an admin proves control of that organization. They are not a wallet or OAuth-subject handle store.

There is no production default under `/app/data` or `/home`. A container-local
file is not durable, and this app cannot read an old file out of `/app/data`.
The first production start begins with an empty document. Nothing is imported.

## App Service settings

The app reads these application settings and no storage key or connection string:

- `S3RCH_IDENTITY_BLOB_ACCOUNT` — storage account name (3–24 lowercase letters and digits)
- `S3RCH_IDENTITY_BLOB_CONTAINER` — blob container name

The document is the single blob `identity-links.json` in that container. The
endpoint is `https://<S3RCH_IDENTITY_BLOB_ACCOUNT>.blob.core.windows.net`.
Auth is `DefaultAzureCredential` limited to the App Service managed identity.
A system-assigned identity needs no extra setting. A user-assigned identity
also needs `AZURE_CLIENT_ID` set to that identity's client id (not a secret).

Give that identity the **Storage Blob Data Contributor** role on the storage
account or on the container. The container must already exist and its public
access level must be **Private**. The app does not create the container and
does not change its access policy. Startup fails if the account, container, or
identity cannot be used. A missing blob is created as `{"v":1,"people":[]}`.
A blob that is not valid version-1 JSON fails startup and is left unchanged.

The deploy workflow checks the two settings before it builds or deploys.
`WEBSITES_ENABLE_APP_SERVICE_STORAGE`, `S3RCH_IDENTITY_STORAGE_ROOT`, and
`S3RCH_IDENTITY_LINKS` are not required.

Development still uses `S3RCH_IDENTITY_LINKS` or `data/identity-links.json`.
That file is not read in production.

## Writes

A blob write sends `If-Match` with the ETag from the read. The first create
sends `If-None-Match: *`. A conflict (HTTP 412 or 409) retries the whole
read-modify-write. The document stores the same owner and handle records as
the development file, and no provider token. Request handling does not
recreate a blob that disappears after startup.

The development file still writes a mode-0600 temporary file and renames it.
A second development writer is refused while `identity-links.json.lock` is
present. Stop writers, check the file, remove that directory, and start again.

The forum and Gun seed cache stay temporary. The forum page says posts and
snapshots on the seed server can disappear when it restarts. Those caches are
not stored in the identity blob.

Tests use an injected blob client, including a second process reading a link
written by the first, and a conditional-write conflict that is retried. They
do not call live Azure.
