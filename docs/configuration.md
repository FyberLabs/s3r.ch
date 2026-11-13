# Configuration reference

This is the list of every `S3RCH_*`, `PANOPTICON_*`, and `GUN_*` setting the server or the deploy scripts read. `scripts/check-config-reference.mjs` fails when code reads a name that is not in the table, and when the table names a setting the scanned code does not read.

Operator walkthroughs, including SIWE, TURN, backup, and optional Panopticon login, are [install-minimal.md](install-minimal.md) and [install-panopticon.md](install-panopticon.md). Published images are [release.md](release.md).

Panopticon is optional at runtime. With every `PANOPTICON_*` name unset, the process still serves and `GET /api/health` reports `dependencies.panopticon.status` as `not-configured`.

Identity in the browser is a Gun SEA public key. Wallet addresses and OAuth subjects are linked credentials on the identity document. They are not that key. The document format is in [install-minimal.md](install-minimal.md#identity-storage).

Settings outside this table (`IDENTITY_SESSION_SECRET`, `SEED_SECRET`, `PORT`, `HOSTNAME`, `NODE_ENV`, and the outbound and confirm names) are in the install guide. Production requires `IDENTITY_SESSION_SECRET` (32 characters or more) for session routes. The image sets `PORT=8080`, `HOSTNAME=0.0.0.0`, and `NODE_ENV=production`.

| Setting | Required | Default | Secret | What it does |
| --- | --- | --- | --- | --- |
| `S3RCH_EXPERIMENTS_ENABLED` | no | unset | no | Set to 1 to enable the optional landing experiment. Withdrawal remains available after disabling. |
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
| `GUN_FILE` | no | `data/radata` under the process cwd; the image sets `/app/data/radata` | no | Directory for this process's Gun radisk. Create it on a persistent volume. |
| `GUN_SNAPSHOT` | no | `data/snapshot.json` under the cwd; the image sets `/app/data/snapshot.json` | no | JSON cache of seeder public items. |
| `PANOPTICON_API_KEY` | no | unset | yes | `X-Api-Key` for the TURN, oracles, and payments hops. All three of this key, `PANOPTICON_TENANT_ID`, and that hop's base must be set or the hop stays unconfigured. |
| `PANOPTICON_ORACLES_BASE` | no | unset | no | Attest origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `PANOPTICON_ORACLES_TENANT_ID` | no | unset | no | Tenant for the Oracles-only product key. Set both Oracles credential settings together. |
| `PANOPTICON_ORACLES_API_KEY` | no | unset | yes | Server-only Oracles product key. A partial dedicated pair disables the hop. When both settings are absent Oracles uses the shared product credentials. |
| `PANOPTICON_PAYMENTS_BASE` | no | unset | no | Payments origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `PANOPTICON_TENANT_ID` | no | unset | no | Marketplace tenant UUID sent as `X-Tenant-ID`. An identifier. The process treats a missing value as unconfigured. |
| `PANOPTICON_TURN_BASE` | no | unset | no | TURN allocate origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `S3RCH_FORUM` | no | `data/forum.json` under the cwd (`/app/data/forum.json` in the image) | no | Forum ledger file. Same disk as the Gun directory. |
| `S3RCH_IDENTITY_BLOB_ACCOUNT` | no for boot; required for production identity writes | unset | no | Azure Storage account name (3–24 lowercase letters and digits). |
| `S3RCH_IDENTITY_BLOB_CONTAINER` | no for boot; required for production identity writes | unset | no | Private blob container that already exists. The blob name is `identity-links.json`. |
| `S3RCH_IDENTITY_LINKS` | no | `data/identity-links.json` when `NODE_ENV` is not production | no | Development identity file. Production does not read this path. |
| `S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS` | no | `60000` | no | How long the blob worker may take to start. An integer from 1000 through 120000 is used; anything else stays 60000. The background probe allows up to 200000 for that start, then adds 90 seconds for the blob call. |
| `S3RCH_LOGIN_PROVIDERS` | no | SIWE, plus one provider id `panopticon` built from `S3RCH_OAUTH_*` when the issuer is set | no | JSON array that replaces the default provider list. Include the SIWE entry. |
| `S3RCH_SIWE_POLICY` | Server-only JSON: `allowed_hosts`, `allowed_origins`, `contract_chain_id` (1 only), optional `rpc_url` (HTTPS). Omit to preserve the built-in host policy and public mainnet RPC. Invalid configured policy refuses login. See [SIWE deployment policy](identity.md#siwe-deployment-policy). |
| `S3RCH_LOGIN_PROVIDER_ISSUER_MOVE` | no | unset | no | `<provider id>:<issuer>` pairs, comma-separated, approving a pinned issuer move. Remove it after the next successful login. |
| `S3RCH_OAUTH_CLIENT_ID` | no | `s3rch-web` | no | Client id for the single default OIDC provider. Public PKCE. No client secret. |
| `S3RCH_OAUTH_ISSUER` | no | unset | no | Issuer for that default provider. Unset, and with `S3RCH_LOGIN_PROVIDERS` unset, means SIWE only. |
| `S3RCH_OAUTH_WALLET_URL` | no | unset | no | Optional HTTPS URL the default provider calls to read a bound wallet. The access token is dropped after that read. |
| `S3RCH_PANOPTICON_TENANT_ID` | bootstrap validation only | unset | no | Legacy bootstrap helper validates the UUID. Release promotion preserves the existing App Service `PANOPTICON_TENANT_ID`; it does not rewrite it. |
| `S3RCH_TEST_DEPLOY_CLIENT_ID` | test deployment only | unset | no | Azure client ID generated by infra and synced into the GitHub `test` environment. Scoped to the test app and ACR import; no production app write access. |
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
| `S3RCH_SQUAD_PILOT` | Empty (disabled) | Key Vault-backed JSON scope and verification policy for the configured Squad. Contains a fixed HTTPS origin, forum/owner and explicit witness policy; it contains no owner signing key. Requires the ACL statement source and separate Spanopticon identity replay settings below. Missing configuration fails closed. The shared site issuer reads `IDENTITY_SESSION_SECRET`. |
| `S3RCH_SQUAD_BLOB_ACCOUNT` | Ignored | Retired from application runtime. Existing configuration cannot select a Blob authority backend. |
| `S3RCH_SQUAD_BLOB_CONTAINER` | Ignored | Retired from application runtime. The old synthetic fixture remains confined to CI/operator tooling. |

### Public feed storage migration

| Setting | Required | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `S3RCH_MEDIA_STORAGE_ORIGIN` | for media | unset | no | Fixed HTTPS Spanopticon gateway origin. Media routes remain unavailable until all three settings and trusted Squad authority are configured. |
| `S3RCH_MEDIA_STORAGE_TENANT_ID` | for media | unset | no | Dedicated s3r.ch storage tenant UUID. |
| `S3RCH_MEDIA_STORAGE_API_KEY` | for media | unset | yes | Dedicated server-only key with storage:objects:read/write and storage:media:read/write. Never use the public-feed key. |
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
then enforce current object ACL. A token alone is not an object grant.

| Variable | Default | Purpose |
| --- | --- | --- |
| `S3RCH_AGENT_SESSION_CONFIG` | Unset (disabled) | Private JSON with exact `origin`, `source` (`origin`, `tenant`, `scope`) and `authority` (`jwks`, `policy`, `pinnedIss`) fields. `policy` contains `allowedDomains`, `allowedUris`, `allowedChainIds`, and explicit `clockSkewSeconds` (0–300). Witness keys are independently trusted configuration; source responses cannot install them. |
| `S3RCH_DELEGATION_SOURCE_API_KEY` | Unset | Dedicated service key with `acl:delegations:read` and the operator-bound tenant/subject/scope. It is never sent to the client. |

The origin must match the configured s3r.ch deployment. The delegation source and
existing Spanopticon identity replay settings must name the same tenant. The
shared identity secret and durable replay backend are mandatory. No fallback
creates stores, enrolls identities, accepts request-supplied history or activates
these routes from legacy Squad configuration. These settings remain unset until
an operator has provisioned the protected owner journal and staged credentials.
