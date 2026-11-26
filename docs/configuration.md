# Configuration reference

This is the list of every `S3RCH_*`, `PANOPTICON_*`, and `GUN_*` setting the server or the deploy scripts read. `scripts/check-config-reference.mjs` fails when code reads a name that is not in the table, and when the table names a setting the scanned code does not read.

Operator walkthroughs, including SIWE, TURN, backup, and optional Panopticon login, are [install-minimal.md](install-minimal.md) and [install-panopticon.md](install-panopticon.md). Published images are [release.md](release.md).

Panopticon is optional at runtime. With every `PANOPTICON_*` name unset, the process still serves and `GET /api/health` reports `dependencies.panopticon.status` as `not-configured`.

Identity in the browser is a Gun SEA public key. Wallet addresses and OAuth subjects are linked credentials on the identity document. They are not that key. The document format is in [install-minimal.md](install-minimal.md#identity-storage).

Settings outside this table (`IDENTITY_SESSION_SECRET`, `SEED_SECRET`, `PORT`, `HOSTNAME`, `NODE_ENV`, and the outbound and confirm names) are in the install guide. Production requires `IDENTITY_SESSION_SECRET` (32 characters or more) for session routes. The image sets `PORT=8080`, `HOSTNAME=0.0.0.0`, and `NODE_ENV=production`.

| Setting | Required | Default | Secret | What it does |
| --- | --- | --- | --- | --- |
| `S3RCH_NIGHTLY_RUN_CONFIG` | no | unset | yes | Private TEST owner JSON with separate controller/owner keys and both declared suite scopes. Enables guarded Next entry routing when explicitly configured; absent preserves native handlers, malformed or changed configuration refuses. No credentials or reader cases are installed by source wiring. |
| `S3RCH_DEVICE_TRANSFER_CONFIG` | for device transfer | unset | no | Exact scope, Auth/ACL routes and existing OIDC provider; see below. |
| `S3RCH_RECOVERY_ROTATION_ENABLED` | no | unset | no | Enable person-authenticated wallet rotation signing/publication/readback and signed recovery promotion. ACL publication must also be configured. |
| `S3RCH_RECOVERY_STORE_ENABLED` | no | unset | no | Explicitly enable person-authenticated recovery ciphertext reads and signed puts. |
| `S3RCH_EXPERIMENTS_ENABLED` | no | unset | no | Set to 1 to enable the optional landing experiment. Withdrawal remains available after disabling. |
| `S3RCH_LINKED_OIDC_CONFIG_FILE` | for linked OIDC proof | unset | yes | Absolute owner-only Auth broker configuration; requires matching existing-person provider and complete linked identity source. |
| `S3RCH_LINKED_IDENTITY_CONFIG_FILE` | for linked identity | unset | yes | Absolute owner-only complete-source and witness-trust file; missing leaves linked login unavailable. |
| `S3RCH_EXPERIMENT_ORIGIN` | for experiments | unset | no | Exact canonical HTTPS site origin. |
| `S3RCH_EXPERIMENT_TENANT` | for experiments | unset | no | Nonzero tenant UUID for private experiment records. |
| `S3RCH_EXPERIMENT_SECRET` | for experiments | unset | yes | Separate random 32-byte experiment root, encoded as 64 lowercase hex characters. |
| `S3RCH_EXPERIMENT_PREVIOUS_SECRETS` | no | unset | yes | Up to three comma-separated previous experiment roots for bounded rotation. |
| `S3RCH_EXPERIMENT_STORAGE_ORIGIN` | for experiments | unset | no | Exact HTTPS private Storage origin; not a browser-supplied endpoint. |
| `S3RCH_EXPERIMENT_CACHE_KEY` | for experiments | unset | yes | Read-only storage:experiments:s3rch:cache:read credential. |
| `S3RCH_EXPERIMENT_OUTBOX_KEY` | for experiments | unset | yes | Separate storage:experiments:s3rch:outbox:read/write credential. |
| `S3RCH_EXPERIMENT_PUBLIC_KEY` | for experiments | unset | no | Ed25519 configuration verification PEM; no private signing key in this process. |
| `S3RCH_EXPERIMENT_PRIMARY_V2` | no | unset | no | Set to 1 only when the primary first-party destination supports named conversion v2. |
| `S3RCH_EXPERIMENT_SECONDARY_CONNECTION` | no | unset | yes | Optional secondary Application Insights connection string. Primary uses APPLICATIONINSIGHTS_CONNECTION_STRING. |
| `S3RCH_EXPERIMENT_SECONDARY_V2` | no | unset | no | Set to 1 only when the configured secondary destination supports named conversion v2. |
| `S3RCH_MEASUREMENTS_ENABLED` | no | unset | no | Exact 1 enables private server dependency observation; activation remains separately owned. |
| `S3RCH_MEASUREMENTS_TENANT` | when measurements enabled | unset | no | Must equal the native experiment tenant. |
| `S3RCH_MEASUREMENTS_SECRET_FILE` | when measurements enabled | unset | yes | Absolute private same-UID regular file for separate Azure ingestion client secret; no symlinks or group/world permissions. |
| `S3RCH_MEASUREMENTS_RELAY_SECRET_FILE` | when measurements enabled | unset | yes | Separate private file containing the relay 64-hex bearer; must differ from current/previous experiment, identity and storage keys. |
| `S3RCH_MEASUREMENTS_INGESTION_ENDPOINT` | when measurements enabled | unset | no | Dedicated HTTPS Azure Monitor ingestion origin; no arbitrary destination/path. |
| `S3RCH_MEASUREMENTS_DCR_ID` | when measurements enabled | unset | no | Dedicated server measurement rule ID, dcr- plus 32 lowercase hex characters. |
| `S3RCH_MEASUREMENTS_DIRECTORY` | when measurements enabled | unset | no | Azure credential directory UUID. |
| `S3RCH_MEASUREMENTS_CLIENT_ID` | when measurements enabled | unset | no | Separate Azure server-ingestion client UUID. |
| `S3RCH_MEASUREMENTS_RELAY_ORIGIN` | when measurements enabled | unset | no | Private HTTPS relay origin; operation and target shape are compiled server-side. |
| `S3RCH_MEASUREMENTS_SAMPLE_EVERY` | no | 100 | no | UUID-based sampling divisor 1 through 10000; unsampled calls use the existing direct path. |
| `GUN_FILE` | no | `data/radata` under the process cwd; the image sets `/app/data/radata` | no | Directory for this process's Gun radisk. Create it on a persistent volume. |
| `GUN_SNAPSHOT` | no | `data/snapshot.json` under the cwd; the image sets `/app/data/snapshot.json` | no | JSON cache of seeder public items. |
| `PANOPTICON_API_KEY` | no | unset | yes | `X-Api-Key` for the TURN, oracles, and payments hops. All three of this key, `PANOPTICON_TENANT_ID`, and that hop's base must be set or the hop stays unconfigured. |
| `PANOPTICON_ORACLES_BASE` | no | unset | no | Attest origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `PANOPTICON_ORACLES_TENANT_ID` | no | unset | no | Tenant for the Oracles-only product key. Set both Oracles credential settings together. |
| `PANOPTICON_ORACLES_API_KEY` | no | unset | yes | Server-only Oracles product key. A partial dedicated pair disables the hop. When both settings are absent Oracles uses the shared product credentials. |
| `PANOPTICON_PAYMENTS_BASE` | no | unset | no | Payments origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `PANOPTICON_TENANT_ID` | no | unset | no | Marketplace tenant UUID sent as `X-Tenant-ID`. An identifier. The process treats a missing value as unconfigured. |
| `PANOPTICON_TURN_BASE` | no | unset | no | TURN allocate origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `S3RCH_FORUM_ADMITTED_OWNERS` | for blob forum | unset | no | JSON array of one to twelve explicitly admitted SEA principals, each with reserved capacity. Public sessions and invitations cannot add admissions. |
| `S3RCH_FORUM_STORAGE` | no | file | no | Set to blob only after the existing forum is migrated. Never falls back to file after a Blob error. |
| `S3RCH_FORUM_BLOB_ACCOUNT` | for blob forum | unset | no | Existing Azure Storage account; managed identity only. |
| `S3RCH_FORUM_BLOB_CONTAINER` | for blob forum | unset | no | Private container with migrated forum.json. No automatic empty document creation. |
| `S3RCH_FORUM` | no | `data/forum.json` under the cwd (`/app/data/forum.json` in the image) | no | Forum ledger file. Same disk as the Gun directory. |
| `S3RCH_IDENTITY_BLOB_ACCOUNT` | no for boot; required for production identity writes | unset | no | Azure Storage account name (3–24 lowercase letters and digits). |
| `S3RCH_IDENTITY_BLOB_CONTAINER` | no for boot; required for production identity writes | unset | no | Private blob container that already exists. The blob name is `identity-links.json`. |
| `S3RCH_TEST_MEDIA_OWNER_WALLET` | no | blank | no | Synthetic media fixture wallet on the canonical TEST App Service. Requires normal wallet sign-in from `https://test.s3r.ch` and uses no human age confirmation. |
| `S3RCH_TEST_MEDIA_OWNER_PRINCIPAL` | no | blank | no | Declared SEA principal for the single allocated TEST media owner on `test.s3r.ch`. Requires the dedicated ACL credential. |
| `S3RCH_TEST_MEDIA_ACL_API_KEY` | no | blank | yes | Server-only Key Vault reference to the synthetic TEST ACL caller key. The paired principal must match the protected ACL binding. |
| `S3RCH_IDENTITY_LINKS` | no | `data/identity-links.json` when `NODE_ENV` is not production | no | Development identity file. Production does not read this path. |
| `S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS` | no | `60000` | no | How long the blob worker may take to start. An integer from 1000 through 120000 is used; anything else stays 60000. The background probe allows up to 200000 for that start, then adds 90 seconds for the blob call. |
| `S3RCH_LOGIN_PROVIDERS` | no | SIWE, plus one provider id `panopticon` built from `S3RCH_OAUTH_*` when the issuer is set | no | JSON array that replaces the default provider list. Include the SIWE entry. |
| `S3RCH_SIWE_POLICY` | Server-only JSON: `allowed_hosts`, `allowed_origins`, `contract_chain_id` (1 only), optional `rpc_url` (HTTPS). Omit to preserve the built-in host policy and public mainnet RPC. Invalid configured policy refuses login. See [SIWE deployment policy](identity.md#siwe-deployment-policy). |
| `S3RCH_LOGIN_PROVIDER_ISSUER_MOVE` | no | unset | no | `<provider id>:<issuer>` pairs, comma-separated, approving a pinned issuer move. Remove it after the next successful login. |
| `S3RCH_OAUTH_CLIENT_ID` | no | `s3rch-web` | no | Client id for the single default OIDC provider. Public PKCE. No client secret. |
| `S3RCH_OAUTH_ISSUER` | no | unset | no | Issuer for that default provider. Unset, and with `S3RCH_LOGIN_PROVIDERS` unset, means SIWE only. |
| `S3RCH_OAUTH_WALLET_URL` | no | unset | no | Optional HTTPS URL the default provider calls to read a bound wallet. The access token is dropped after that read. |
| `S3RCH_PANOPTICON_TENANT_ID` | bootstrap validation only | unset | no | Legacy bootstrap helper validates the UUID. Release promotion preserves the existing App Service `PANOPTICON_TENANT_ID`; it does not rewrite it. |
| `S3RCH_UPLOAD_FIXTURE` | CI only | unset | no | Select `meme`, `audio`, or `video` for a prepared-file private-upload browser contract; unset runs the ordinary upload fixture. Not a runtime setting. |
| `S3RCH_GRANTED_FIXTURE` | CI only | image | no | Select `image`, `audio`, or `video` for the synthetic Granted playback and cleanup browser contract. Not a runtime setting. |
| `S3RCH_ROOM_MEDIA_FIXTURE` | CI only | audio | no | Select `audio` or `video` for the synthetic signed-room reference playback and cleanup browser contract. Not a runtime setting. |
| `S3RCH_TEST_PUBLICATION_APP_ID` | Automatic TEST release step | unset | no | Dedicated GitHub App installed only on FyberLabs/s3r.ch with Contents and Workflows write. TEST environment variable; see [setup](test-publication-identity.md). |
| `S3RCH_TEST_PUBLICATION_APP_PRIVATE_KEY` | Automatic TEST release step | unset | yes | Dedicated publication App key, stored only as a TEST environment secret. Mints a repository-scoped token after deployment verification; never reused for static dispatch. |
| `S3RCH_STATIC_DISPATCH_APP_ID` | TEST deploy and stable release workflows | unset | no | Numeric id of the GitHub App that requests TEST app refresh and static publication in FyberLabs/infra. Repository variable. |
| `S3RCH_STATIC_DISPATCH_APP_PRIVATE_KEY` | TEST deploy and stable release workflows | unset | yes | Private key for that app. Repository secret. Each workflow mints a short-lived token limited to Actions on FyberLabs/infra. |
| `S3RCH_TURN_CREDENTIAL` | only with the insecure flag | unset | yes | Fixed TURN credential sent to every signed-in browser when the insecure flag is on. |
| `S3RCH_TURN_INSECURE_STATIC_CREDENTIAL` | no | off | no | `1`, `true`, or `yes` sends `S3RCH_TURN_USERNAME` and `S3RCH_TURN_CREDENTIAL` instead of a minted REST credential. Leave it off. |
| `S3RCH_TURN_SECRET` | when a `turn:` or `turns:` URL is listed | unset | yes | Shared secret for TURN REST credentials. Same value as coturn `static-auth-secret`. Never `NEXT_PUBLIC_*`. |
| `S3RCH_TURN_TTL_SEC` | no | `3600` | no | REST credential lifetime in seconds. Integers from 60 through 86400 are used. Anything else stays 3600. |
| `S3RCH_TURN_URLS` | no | unset | no | Comma-separated `stun:`, `turn:`, and `turns:` URLs. Loopback and private addresses are dropped. |
| `S3RCH_TURN_USERNAME` | only with the insecure flag | unset | yes | Fixed TURN username paired with `S3RCH_TURN_CREDENTIAL`. |

`S3RCH_IDENTITY_STORAGE_ROOT` is not read. A user-assigned Azure identity also needs `AZURE_CLIENT_ID` (the client id, not a secret). The Azure SDK reads that name; this table does not, and the checker does not scan it.

## Controlled Squad pilot

| Setting | Default | Purpose |
| --- | --- | --- |
| `S3RCH_SQUAD_PILOT` | Empty (disabled) | Key Vault-backed JSON scope and verification policy for the configured Squad. Contains a fixed HTTPS origin, forum/owner and explicit witness policy; it contains no owner signing key. Requires the ACL statement source and separate Spanopticon identity replay settings below. Missing configuration fails closed. The shared site issuer reads `IDENTITY_SESSION_SECRET`. The optional `project` object enables the Squad mind map and tasks. It requires a Plane binding and contains the existing private tenant record service HTTPS `recordOrigin` and an authorized `recordKey` for the project records in the same tenant. |
| `S3RCH_SQUAD_BLOB_ACCOUNT` | Ignored | Retired from application runtime. Existing configuration cannot select a Blob authority backend. |
| `S3RCH_SQUAD_BLOB_CONTAINER` | Ignored | Retired from application runtime. The old synthetic fixture remains confined to CI/operator tooling. |

### Public feed storage migration

| Setting | Required | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `S3RCH_MEDIA_READER_BINDINGS` | for private media | unset | yes | Server-only JSON: fixed gateway origin, tenant UUID, and at most 64 `{principal, apiKey}` readers. Each dedicated key must authenticate a separate ACL subject bound to that enrolled reader. Keys cannot be shared across readers. Requires the protected media source; missing configuration disables private reads. |
| `S3RCH_MEDIA_STORAGE_ORIGIN` | for media | unset | no | Fixed HTTPS Spanopticon gateway origin. Media routes remain unavailable until all three settings and trusted Squad authority are configured. |
| `S3RCH_MEDIA_STORAGE_MODE` | optional | unset | no | Set `allocated-v1` only after registry/provider reconciliation and payload read/write scopes are staged. Ciphertext uses allocated payload routes; unset preserves legacy storage. Ownership registration confirms the existing protected allocation; protected-source capacity still applies. |
| `S3RCH_MEDIA_STORAGE_TENANT_ID` | for media | unset | no | Dedicated s3r.ch storage tenant UUID. |
| `S3RCH_MEDIA_STORAGE_API_KEY` | for media | unset | yes | Dedicated server-only key. Legacy mode uses storage:objects:read/write and storage:media:read/write; allocated-v1 uses storage:media:payload:read/write and fixed-subject ACL owner/read bindings. Never use the public-feed key. |
| `S3RCH_FEED_STORAGE_BACKEND` | no | legacy filesystem until configured | no | `spanopticon` selects tenant records. Explicit `filesystem` is allowed only without any remote settings. Unknown or partial configurations fail closed for refreshes. |
| `S3RCH_FEED_STORAGE_ORIGIN` | for Spanopticon | unset | no | Fixed HTTPS gateway origin with no path, credentials or alternate port. |
| `S3RCH_FEED_STORAGE_TENANT_ID` | for Spanopticon | unset | no | s3r.ch tenant UUID for public-feed records. |
| `S3RCH_FEED_STORAGE_API_KEY` | for Spanopticon | unset | yes | Dedicated server-only `storage:records:read` and `storage:records:write` key. Never use the media or Oracles key. |

Setting all three remote values selects Spanopticon even without an explicit
backend. Startup restores its authoritative named record; when absent, it
conditionally imports the existing local snapshot. Invalid or unavailable remote
state leaves the last local public snapshot available and blocks replacement.
Successful remote commits precede updates to the derived local file and Gun graph.
A conflict reloads remote state and fetches fresh source windows before retrying.
The migration does not delete legacy data or remove existing Azure grants.

The peer listens immediately from its local snapshot while remote restoration
runs. Refreshes wait for that restore to finish. Adoption intent is saved before
any first remote write, so a crash cannot cause a later deleted record to be
reimported from old disk. Authoritative records carry active windows, not an
unbounded history of retired IDs; each peer durably retains its own body-free
retirement set and also retires local rows absent from the authoritative snapshot.

### Optional self-hosted Blob records

| Setting | Required | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `S3RCH_FEED_STORAGE_AZURE_ACCOUNT` | for explicit `azure` backend | unset | no | Self-hosted Azure account name, using the primary HTTPS endpoint. |
| `S3RCH_FEED_STORAGE_AZURE_CONTAINER` | for explicit `azure` backend | unset | no | Existing private container; never created or made public by the adapter. |

Self-hosted installations may set the backend to `azure`, the two values above,
and the tenant ID. They use server-side DefaultAzureCredential (for example a
managed identity with access limited to that container). Spanopticon origin and
API-key settings must be absent. Mixed or incomplete provider settings fail
closed. Fyber's hosted tenant continues to use the `spanopticon` backend.

## Release diagnostics

| Setting | Purpose |
| --- | --- |
| `S3RCH_RELEASE_COLOR` | Optional `blue`, `green`, `test`, or `production` label for error records. |
| `S3RCH_TEST_ORIGIN_ID` | TEST Container Apps only. The existing per-origin Key Vault reference used to authenticate the Cloudflare ingress header for web HTTP and Gun WebSocket traffic. |
| `S3RCH_UPSTREAM_VERSION` | Optional semantic version of the configured canary plane, for browser crash attribution. |
| `S3RCH_UPSTREAM_COLOR` | Optional upstream `blue`, `green`, `test`, or `production` label. |

These labels do not select a release, route traffic, or change session keys.

| `S3RCH_GUN_HEALTH_URL` | Operator-configured HTTPS peer `/api/health` or public `/_peer/api/health` probe. No credentials, query or fragment. |


### First-party experiment events

`APPLICATIONINSIGHTS_CONNECTION_STRING` selects the existing App Service Azure
Monitor Application Insights resource for manual experiment events. The adapter
accepts its instrumentation key and public Azure ingestion/live endpoint fields.
It sends explicit event envelopes with a two-second timeout, no redirects, and
at most eight concurrent requests. No SDK background diagnostics or request
metadata are collected. Invalid or missing configuration drops telemetry without
failing the application request. Accepted ingestion does not guarantee query visibility.


### Startup linked login

This optional flow is disabled by default and consumes the private canonical
startup deployment envelope shared with Spanopticon. `STARTUP_IDENTITY_CONFIG_FILE`
points to an owner-private regular file containing canonical JSON (sorted keys,
compact separators, ASCII escapes and trailing newline), produced by the shared
`controlplane_identity.startup` validator. No private SEA key enters this file.

| Setting | Meaning |
| --- | --- |
| `S3RCH_STARTUP_LOGIN_ENABLED` | Set to `1` only after the owner startup services are configured. |
| `S3RCH_STARTUP_GITHUB_MEMBER_CONFIG` | Private Infra mapping for the TEST GitHub member. Use the dedicated TEST Auth endpoint and leave the operator configuration file unset. |
| `S3RCH_STARTUP_NIGHTLY_MEMBER_CONFIG` | Optional private Infra mapping for the synthetic linked member on `test.s3r.ch`. The dedicated startup client uses the TEST broker and Auth endpoint. |
| `S3RCH_STARTUP_LOGIN_PROVIDER` | Existing configured OIDC provider ID; issuer and client ID must match the private owner broker settings. |
| `S3RCH_STARTUP_AUTH_URL` | Explicit HTTPS Auth endpoint ending in `/auth/startup/identity`; redirects are refused. |

The linked-credential cookie lasts five minutes and carries no access token.
It confirms the configured broker account, not permission for a mesh action.
The browser must already hold the matching SEA key; this flow never creates or
rekeys it. Wrapped keys must be unlocked through the existing key controls.
Organization metadata does not replace current SociACL Check or owner API checks.
The ordinary wallet/OAuth path remains separate. Nothing enables this flow from
public request parameters or from an email match.

### Identity replay storage

| Setting | Default | Purpose |
| --- | --- | --- |
| `S3RCH_IDENTITY_REPLAY_BACKEND` | Unset | `spanopticon` enables the dedicated consume-only replay API. All four settings are required together; partial/unknown values fail closed. Unset preserves the existing pilot store. |
| `S3RCH_IDENTITY_REPLAY_ORIGIN` | Unset | Fixed HTTPS storage gateway origin, with no path or alternate port. |
| `S3RCH_IDENTITY_REPLAY_TENANT_ID` | Unset | The s3r.ch storage tenant UUID. |
| `S3RCH_IDENTITY_REPLAY_API_KEY` | Unset | Private server-only key with only `storage:replays:consume`. Never reuse the feed/media key. |

Challenges bind to the backend origin, tenant and issuer namespace. Challenges
issued for the old store cannot be exchanged against the new store, or vice
versa, including mixed-version rollout. Existing session tokens keep their
wire contract. Switching storage requires a fresh challenge; no live replay
state is copied or reset. Do not delete/restore the active replay prefix.
This moves only challenge replay state; Squad ledger/assignment storage remains
a separate migration. Runtime activation waits for its dedicated credential.

### Trusted signed statement source

| Setting | Default | Purpose |
| --- | --- | --- |
| `S3RCH_AUTHORITY_BACKEND` | Unset | `acl` selects the independently provisioned ACL owner source. An enabled Squad without `acl` fails closed, including old `legacy` settings. No Blob or assignment-journal fallback exists. |
| `S3RCH_STATEMENT_SOURCE_ORIGIN` | Unset | Fixed HTTPS gateway origin, without path, credentials or alternate port. |
| `S3RCH_STATEMENT_SOURCE_TENANT_ID` | Unset | The s3r.ch tenant UUID bound by the ACL owner. |
| `S3RCH_STATEMENT_SOURCE_SCOPE` | Unset | Explicit operator-provisioned graph scope; never selected by a browser. |
| `S3RCH_STATEMENT_SOURCE_API_KEY` | Unset | Dedicated private service key with `acl:statements:read` and `acl:statements:write`, bound to that graph's service subject. |
| `S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI` | Unset | Optional versionless Azure Key Vault secret URI for the Squad statement key. Requires the configured `AZURE_CLIENT_ID` managed identity. Use in place of `S3RCH_STATEMENT_SOURCE_API_KEY`. An unavailable key disables Squad statement operations while the web service continues to serve. |
| `S3RCH_VISOR_COMPANION_RECORD_ORIGIN` | Unset | Fixed HTTPS Spanopticon gateway origin for durable Visor companion-set fencing. Required with the companion record tenant and API key when the Squad pilot exposes `visor-companion`. |
| `S3RCH_VISOR_COMPANION_RECORD_TENANT_ID` | Unset | Storage tenant UUID for companion-set records; must match the ACL statement-source tenant. |
| `S3RCH_VISOR_COMPANION_RECORD_API_KEY` | Unset | Dedicated server-only key with `storage:records:read` and `storage:records:write`. Never reuse the statement-source graph key. |
| `S3RCH_ROOM_WEBHOOK_SIGNING_KEY` | Unset | Server-only HMAC key material for room callbacks. Leave unset to disable the webhook worker. |
| `S3RCH_ROOM_WEBHOOK_RECORD_ORIGIN` | Unset | HTTPS Spanopticon record service for room webhook state. |
| `S3RCH_ROOM_WEBHOOK_RECORD_TENANT_ID` | Unset | Room webhook storage tenant. Must match the ACL statement-source tenant. |
| `S3RCH_ROOM_WEBHOOK_RECORD_API_KEY` | Unset | Dedicated server-only credential for room webhook record reads and writes. |

All four source settings are required when the ACL backend is selected. Source
errors never cause an append retry or a fallback to the legacy journal. A changed
fence requires a fresh snapshot and authorization. The server preserves the
original evaluation time and the ACL owner rechecks it at the atomic commit.

The source requires independently admitted identity history, explicit new-graph
provisioning and protected freshness storage. Neither importing Gun records nor
setting these variables establishes completeness. Provisioning must not enroll
existing peer histories as exclusively owned from genesis. No credential or
source binding is created by s3r.ch configuration.

ACL mode routes authority, statement admission, media checks and readiness reads
through that one source. It requires the separately configured Spanopticon
identity replay backend and does not construct a Blob ledger or replay store.
Legacy assignment mutations return unavailable in this mode; they cannot write
a second authority journal. Existing session wire formats remain unchanged.

The application no longer exposes `/api/squad/pilot/assignment/*` or constructs an
assignment executor. The old Blob constructor is isolated in
`scripts/squad-pilot-fixture.ts` for CI and explicitly invoked operator tooling.
Old deployed pilot settings alone are insufficient: the application stays
unavailable until its owner source and replay are explicitly configured. This
change does not provision a graph, stage credentials, remove stored data or
activate a replacement source. Retire the old infra container and role separately
after confirming that no operator tool still uses them.

Squad connects through the shared `/api/identity/sea` challenge/exchange/logout
endpoint. Its runtime verifies the existing site cookie and exposes no token
issuance actions. Existing `/api/squad/pilot/session/*` aliases forward to that shared handler
for patch compatibility; they do not create a second issuer.
The shared replay configuration remains required and dedicated to identity.


### Native agent identity

`POST /api/identity/agent/challenge` accepts a delegation ID and sorted requested
scopes. `POST /api/identity/agent/exchange` accepts the challenge and agent SEA
signature, returning a bearer token without browser cookies. Every protected
consumer must use `authenticateAgentRequest` with its own required scopes and
then enforce current object ACL for the returned agent principal. The delegating
owner does not lend its object grants to the bot. A token alone is not an object grant.

| Variable | Default | Purpose |
| --- | --- | --- |
| `S3RCH_AGENT_SESSION_CONFIG` | Unset (disabled) | Private JSON with exact `origin`, `source` (`origin`, `tenant`, `scope`) and `authority` (`jwks`, `policy`, `pinnedIss`) fields. `policy` contains `allowedDomains`, `allowedUris`, `allowedChainIds`, and explicit `clockSkewSeconds` (0–300). Witness keys are independently trusted configuration; source responses cannot install them. |
| `S3RCH_DELEGATION_SOURCE_API_KEY` | Unset | Dedicated service key with `acl:delegations:read` and the operator-bound tenant/subject/scope. It is never sent to the client. |
| `S3RCH_SQUAD_DELEGATION_WRITE_API_KEY` | Unset | Separate server credential with `acl:delegations:write` for the same delegation journal scope and tenant as the native reader. Enables signed-in Squad owner enrollment for the configured Plane roster. |

The origin must match the configured s3r.ch deployment. The delegation source and
existing Spanopticon identity replay settings must name the same tenant. The
shared identity secret and durable replay backend are mandatory. No fallback
creates stores, enrolls identities, accepts request-supplied history or activates
these routes from legacy Squad configuration. These settings remain unset until
an operator has provisioned the protected owner journal and staged credentials.

### Private media sharing preparation

The fixed-owner media proxy accepts `share-view` with only `{object, reader}`.
It validates the protected plan's grants, selected bindings and projected direct
ACL snapshot before returning it. `prepareShare` signs those exact grants using
the held unlocked identity and refuses if the session locks during the request.
No grant is published by preparation; it neither enrolls a reader nor activates
storage. The signed plan must be retained in encrypted recovery storage before
publication, followed by the matching epoch and recipient wraps. Full sharing
publication and UI remain separate work under #301.

Sharing recovery uses a separate encrypted IndexedDB journal and an exclusive
browser lock. All signed grants, the next epoch and opaque reader wraps are saved
before access changes are submitted. Resume compares exact retained values through
`share-state` and refuses competing changes. The UI keeps an incomplete operation
as pending, including during the one-hour epoch settlement or a future grant.
Closing the page does not undo accepted changes. Recovery stores no plaintext
file or raw file key; identity changes clear the visible sharing controls.

Sharing publication uses `share-check` and retains the exact returned fence for
the following write. It never refreshes the owner view between comparison and
publication. Concurrent state changes refuse instead of rewriting a stale plan.

Stop sharing also uses encrypted recovery: `unshare-view` cancels the selected
recipient while preparing the remaining readers for the next epoch. The removed
reader receives no new wrap. The cancellation can take effect before settlement;
remaining access can be pending until the saved epoch and statuses are ready.

### Contacts

| Variable | Required | Purpose |
| --- | --- | --- |
| `S3RCH_CONTACT_READER_BINDINGS` | no | Server-only fixed principal/API-key bindings for the contacts service. |

`S3RCH_CONTACT_READER_BINDINGS` is optional, server-only JSON using the media
reader binding format (`origin`, `tenant`, `readers`). Each reader
maps a stable SEA principal to a separately configured ACL API key. The tenant
must match `S3RCH_STATEMENT_SOURCE_TENANT_ID`. Never use a peer-provided origin.
Only the configured HTTPS origin is rendered to the contacts page; API keys
stay on the server. Unset or invalid configuration leaves contacts unavailable.

The ACL operator installs the protected contacts journal and owner bindings
separately. The browser consumes signed public descriptors and stores contact
keys, decisions, blocks and pending ciphertext in an encrypted, revisioned vault.
Existing contact keyrings must be restored explicitly; this page does not create
a replacement identity or contact secret. It uses the current unlocked identity
and clears its private view when that identity changes or the page is hidden.

### Existing identity device transfer

`S3RCH_DEVICE_TRANSFER_CONFIG` is a server-only JSON object with `v:1`,
`scope:{sourceOrigin,destinationOrigin,application,tenant,audience}`, `auth`,
`acl`, and `provider`. Both origins must equal this site's HTTPS origin;
application is `s3r.ch`, tenant is the configured UUID, and audience must match
Auth and ACL. `auth` ends `/auth/sea-device-link/v1/`; `acl` ends
`/api/v1/acl/sociacl/device-transfer/`. `provider` selects an existing configured
OIDC provider. Missing or invalid configuration disables device transfer.
Register `/api/identity/device/callback` on that provider's existing client and
provision ordinary person authorization for `auth:device:transfer` and
`acl:identity:transfer` in the owning plane. No browser action grants these scopes.
The transfer-specific PKCE flow keeps its bearer encrypted in a five-minute
HttpOnly cookie; ordinary wallet/OAuth cookies are never treated as that bearer.
See [device transfer](device-transfer.md) for storage and acceptance boundaries.

### Complete linked-credential authority

`S3RCH_LINKED_IDENTITY_CONFIG_FILE` is optional and absent by default. It points
to an absolute owner-only, single-link regular file (at most 64 KiB). The file
uses compact recursively sorted-key JSON plus a final newline. Its exact fields
are `version: 1`, `origin` (this deployment's canonical HTTPS origin), `source`,
`trust`, `walletChainIds`, and `oidc`.

`source` contains `origin` (ACL HTTPS origin), `tenant`, `source` (the configured
whole authority UUID), and `apiKey` for its private service subject. `trust` holds
locally configured `jwks`, SIWE `policy`, and `pinnedIss` array. `oidc` is an array
of exact `issuer`, `clientId`, `tenant`, `tenantClaim`, `jwks` records. Provider
verification uses those local keys; neither ACL response keys nor browser data can
install witness trust. Duplicate issuer/tenant bindings refuse configuration.

This wires ACL #189's complete credential domain into the existing linked SEA
challenge/exchange issuer. It is not an owner-only history export and does not
create identities. Missing configuration keeps linked login unavailable. Source
scope, complete histories, candidate inclusion, revocations and current keys are
checked again by shared SociACL helpers. Responses cannot omit a candidate present
in the complete history or replace configured witness keys. The existing replay
backend and one-time challenge consumption remain required.

Auth #69's provider orchestration and #583's restoration browser flow are separate
consumers. This setting alone does not activate them, provision credentials, or
register reader cases. No private file is included in the image or this repository.

Setting `S3RCH_RECOVERY_STORE_ENABLED` to `true` explicitly enables authenticated recovery current/pending reads and signed current-copy puts through the device-person session. It defaults off and requires the existing device-transfer configuration plus ACL signed-store subject bindings. Only ciphertext and public CAS metadata cross this boundary; the browser keeps passphrases and key material. This setting does not provision storage, enroll identities, enable rotation or register readers.


`S3RCH_RECOVERY_ROTATION_ENABLED=true` separately permits public signed wallet
rotation requests and exact readback through the existing device-person session.
It also permits signed recovery promotion when recovery storage is enabled.
The ACL service separately requires its configured subject binding, rotation
scope and publication flag. Neither setting creates identities, issues a browser
session, registers readers or sends private key/passphrase material to a server.

### Vault ciphertext API

| Setting | Required | Default | Secret | Purpose |
| --- | --- | --- | --- | --- |
| `S3RCH_VAULT_STORAGE` | for vault sync | unset | yes | Shared storage configuration and independently provisioned owner/vault bindings. |

`S3RCH_VAULT_STORAGE` is optional server-only JSON with `origin`, `tenant`,
`apiKey`, and `bindings` (up to 128 `{owner, vaultId}` entries). The origin is
an HTTPS Spanopticon origin; vault IDs are 64 lowercase hexadecimal characters.
Use the same shared storage tenant in both products. The key needs vault read/write scopes. Immutable ciphertext uses vault-scoped
create-only records, never tenant-wide object reads. Provision bindings independently; a caller
cannot enroll a vault by supplying an owner field. Never expose this setting to
browser bundles. Missing configuration leaves `/api/vault` unavailable. The
existing configured identity and complete authority source are also required.

On TEST only, the app binding can also include `authoritySource` with
`origin`, `tenant`, `scope`, `apiKey`, and `authority`. Use the same tenant,
the `s3rch-native-vault` ACL snapshot scope, a dedicated read credential, and
the witness policy for that source. The dedicated source is used for vault
identity resolution. Squad and media retain their own source.
