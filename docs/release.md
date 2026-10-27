# Packaged release

A `vX.Y.Z` tag (no pre-release suffix) builds the repo `Dockerfile` and publishes one linux/amd64 image to GHCR. The workflow tags `X.Y.Z`, `X.Y`, and `latest`, and records the image digest on the GitHub Release for that tag.

The image name is `ghcr.io/` plus the repository name in lowercase. For this repository that is `ghcr.io/fyberlabs/s3r.ch`.

```text
ghcr.io/fyberlabs/s3r.ch:1.2.3
ghcr.io/fyberlabs/s3r.ch:1.2
ghcr.io/fyberlabs/s3r.ch:latest
ghcr.io/fyberlabs/s3r.ch@sha256:<digest>
```

Pin the digest from the Release. `latest` and `X.Y` move when a newer stable tag is pushed. The Release body is [`.github/RELEASE_TEMPLATE.md`](../.github/RELEASE_TEMPLATE.md) with the digest filled in. It always has **Config changes** and **Migration** sections. Edit those in the template on the commit you tag, or edit the Release after it is published.

`NEXT_PUBLIC_WC_PROJECT_ID` is empty in this image, so WalletConnect is left out of the bundle. Pass that build-arg only when you build the Dockerfile yourself.

The package is marked public when the workflow's token is allowed to. If that call is refused, mark the GHCR package public once so other deployments can pull it.

Install steps for a core deployment and for optional Panopticon are [install-minimal.md](install-minimal.md) and [install-panopticon.md](install-panopticon.md). Every `S3RCH_*`, `PANOPTICON_*`, and Gun setting is [configuration.md](configuration.md).

## Run with Panopticon unset

The process listens on 8080 as user `nextjs` (uid 1001, group `nodejs`). No `PANOPTICON_*` setting is required. The only production secret the session routes require is `IDENTITY_SESSION_SECRET` (32 characters or more).

```bash
docker run --rm -p 8080:8080 \
  -e IDENTITY_SESSION_SECRET \
  -v s3rch-data:/app/data \
  ghcr.io/fyberlabs/s3r.ch@sha256:<digest>
```

`GET /api/health` returns HTTP 200. `dependencies.panopticon.status` is `not-configured`. `dependencies.gun.status` is `ok` once the peer attaches. With the blob settings unset, `dependencies.identity.status` becomes `unavailable` and wallet sign-in answers 503. Feed, forum, and `/gun` still serve. See the install guide for Azure Blob, a local file when `NODE_ENV` is not production, TURN, and backup.

## Persistent paths

| Path | What it is |
| --- | --- |
| `/app/data` | Volume. Holds Gun radisk, the seeder snapshot, and the forum ledger. |
| `/app/data/radata` | `GUN_FILE`. A directory. One process writes it. |
| `/app/data/snapshot.json` | `GUN_SNAPSHOT`. |
| `/app/data/forum.json` | `S3RCH_FORUM`. |
| Azure Blob `identity-links.json` | Production identity document, via `S3RCH_IDENTITY_BLOB_ACCOUNT` and `S3RCH_IDENTITY_BLOB_CONTAINER`. Not stored on `/app/data`. |

The image declares `VOLUME /app/data`. A bind mount must be writable by uid 1001. Replacing the container without that volume drops radisk, the snapshot, and the forum file. The identity blob survives when the two blob settings still point at it. Copying server disk does not copy the browser's Gun SEA key.

## This repository's App Service deploy

Pushes to `master` still build this repo and push `${ACR_LOGIN_SERVER}/s3rch:<git sha>` and `:prod`, then point App Service at the `:prod` tag. That path is unchanged, including the required `S3RCH_PANOPTICON_TENANT_ID` check and the identity blob check. Those checks are this deploy workflow, not a requirement of the image.

To deploy a published release instead of building, run the Deploy workflow manually and set `image_digest` to the `sha256:…` value from the GitHub Release. The job pulls `ghcr.io/<repository>@<digest>`, pushes that image into the existing registry, and sets the App Service container to the registry digest. Leave `image_digest` empty to build the selected ref, the same as a master push. The published image does not include `NEXT_PUBLIC_WC_PROJECT_ID`; a master build still passes that variable when it is set.
