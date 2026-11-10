# Test and production releases

Every merge to `master` (this repository's default branch) builds one linux/amd64 image, anonymously pulls and smoke-tests its digest, and advances the public `:test` channel. The web app and Gun peer restart on that channel. The job checks each running revision and its own dependencies before publishing the `test-<full SHA>` prerelease. A failed rollout restores the previous channel image.

The successful test job signs its deployment manifest with GitHub artifact attestation. Promotion and infra verify that signature against the exact source, workflow and successful run before accepting the image. The manifest may include a digest so that image can be verified. Evidence persists independently of expiring CI artifacts.

A stable `vX.Y.Z` tag names one patch. Every code change gets a new patch version. The release job waits for that commit's successful test deployment, publishes `release-manifest.json`, and labels the patch `:X.Y.Z`. A downloadable package uses that version, not a hash.

Running services follow a tag and pick up later patches on that line. They are patch-compatible within a minor version.

- TEST runs `ghcr.io/fyberlabs/s3r.ch:test`.
- A production service runs the minor line, for example `ghcr.io/fyberlabs/s3r.ch:1.4`. Promoting `v1.4.2` moves `:1.4` to that patch when no newer `1.4` patch is already published. A new minor line is an explicit choice.
- `:prod` and `:latest` name the current production line. An older minor line is not replaced by a newer one on its own.

```text
ghcr.io/fyberlabs/s3r.ch:test
ghcr.io/fyberlabs/s3r.ch:1.4
ghcr.io/fyberlabs/s3r.ch:1.4.2
```

A digest may be stored on the release record so someone can verify which image a tag resolved to. It is not the image reference a running service uses.

Infra reconciles **https://s3r.ch** to the minor line of the highest stable release after a successful Terraform apply and every 15 minutes. It verifies the manifest, tag commit and successful test run, and verifies the deployed revision and dependencies. There is no per-release credential setup, rebuild, or manual digest pin. Infra preserves production app settings, including the existing Panopticon tenant. Failed deployment remains a failure until a subsequent reconciliation succeeds; it is never recorded as accepted production.

The GitHub `release` environment has no required reviewer. Publication does not require branch protection. Default-branch ancestry and trusted release scripts remain enforced. Configure package visibility as Public once; the merge pipeline checks anonymous pulling. WalletConnect's build setting is taken from `NEXT_PUBLIC_WC_PROJECT_ID` on the test build and remains identical in production.

## Initial infrastructure migration

Merge and apply the companion infra change first. It creates the separate test App Service, identity container, generated Key Vault session/seed secrets, scoped Azure deployment identity and public DNS. Infra config maps the output to the `test` environment variable `S3RCH_TEST_DEPLOY_CLIENT_ID`; restrict that environment to `master` without adding reviewers. Production stays on its existing deployment until the first stable release with a promotion manifest. Legacy releases without that manifest are not reinterpreted as tested artifacts.

The test app has its own credentials and identity storage, and does not inherit production Panopticon API credentials. Optional authenticated Panopticon services require separately scoped test credentials. Test OAuth redirects must be registered in the identity provider. Existing production tenant/configuration remains provisioned independently of releases.

`SOURCE_REVISION` is a Docker build argument baked into `APP_BUILD_REVISION`; it is not a new runtime secret or operator input. `/api/version` exposes only this public commit identifier.

Install guides: [core](install-minimal.md), [optional Panopticon](install-panopticon.md), [configuration](configuration.md).

## Run with Panopticon unset

The process listens on 8080 as user `nextjs` (uid 1001, group `nodejs`). No `PANOPTICON_*` setting is required. The only production secret the session routes require is `IDENTITY_SESSION_SECRET` (32 characters or more).

```bash
docker run --rm -p 8080:8080 \
  -e IDENTITY_SESSION_SECRET \
  ghcr.io/fyberlabs/s3r.ch:1.4
```

Use `:test` instead of `:1.4` for a test installation. The Gun peer is a second process from the same tag. See [deployment.md](deployment.md).

`GET /api/health` returns HTTP 200. `dependencies.panopticon.status` is `not-configured`. The web process reports Gun as `external`. The peer reports Gun as `ok`. With the blob settings unset, `dependencies.identity.status` becomes `unavailable` and wallet sign-in answers 503. The feed and the forum still serve. `/gun` is the peer. See the install guide for Azure Blob, a local file when `NODE_ENV` is not production, TURN, and backup.

## Persistent paths

| Path | What it is |
| --- | --- |
| `/app/data` | Volume. Holds Gun radisk, the seeder snapshot, and the forum ledger. |
| `/app/data/radata` | `GUN_FILE`. A directory. One process writes it. |
| `/app/data/snapshot.json` | `GUN_SNAPSHOT`. |
| `/app/data/forum.json` | `S3RCH_FORUM`. |
| Azure Blob `identity-links.json` | Production identity document, via `S3RCH_IDENTITY_BLOB_ACCOUNT` and `S3RCH_IDENTITY_BLOB_CONTAINER`. Not stored on `/app/data`. |

The image declares `VOLUME /app/data`. A bind mount must be writable by uid 1001. Replacing the container without that volume drops radisk, the snapshot, and the forum file. The identity blob survives when the two blob settings still point at it. Copying server disk does not copy the browser's Gun SEA key.
