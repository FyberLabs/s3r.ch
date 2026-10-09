# Durable account-link storage

Account links are account data. They must survive replacement containers and
recycles. A control-plane identity service remains the preferred long-term
owner; this change implements issue #98's mounted-volume fallback without
introducing another service inside the frontend.

Production requires an absolute `S3RCH_IDENTITY_LINKS` path beneath
`S3RCH_IDENTITY_STORAGE_ROOT`. Startup checks that the root is a Linux mount,
rejects container/memory layers, symlink escapes, missing/unreadable files and
malformed JSON or unsupported versions, and checks write access. There is no production default
under `/app/data`. Development keeps the existing local default.

For Azure App Service, use:

- `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true`
- `S3RCH_IDENTITY_STORAGE_ROOT=/home`
- `S3RCH_IDENTITY_LINKS=/home/s3rch-identity/identity-links.json`

Azure documents `/home` persistence when App Service storage is enabled in
[custom container configuration](https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container?pivots=container-linux).
The deploy workflow checks those settings before building/deploying the new
image. It deliberately does not turn storage on automatically: changing that
setting can recycle the current container before its local links are saved.

## First migration

1. Pause new account linking and securely export the current running container's
   `/app/data/identity-links.json` before any setting change or restart. Use the
   actual `S3RCH_IDENTITY_LINKS` value if one is already configured. Do not put
   identity records in logs, Git or build artifacts. Existing links already lost
   on previous redeploys cannot be recovered by this change.
2. Enable persistent App Service storage. From the app container, verify `/home`
   is a separate mount in `/proc/self/mountinfo`; Kudu's filesystem alone is not
   proof that the application container has the mount.
3. Create `/home/s3rch-identity` accessible only to the app identity and import
   the exported file as `identity-links.json` with mode 0600. Validate version 1
   and preserve the exact owner/handle mapping. If there has never been any link,
   explicitly initialize `{"v":1,"people":[]}`. A missing file fails startup.
4. Set the two identity path settings, deploy the new image, create a synthetic
   wallet/OAuth link and verify the owner mapping. Replace the container and
   recycle the app, then verify the same mapping again. Keep the issue open until
   both live checks pass. Retain the export securely until acceptance is complete.

## Writes and recovery

A link update holds an atomic directory lock around its complete read/write
transaction. A competing process is refused instead of overwriting another
process's links. Writes use a mode-0600 temporary file, fsync it, and atomically
rename it. No provider token is stored. Reads see the old or new complete file.

A crashed writer can leave `identity-links.json.lock`. New links then fail
closed. Stop all app writers, validate the saved file, remove that lock directory
and restart. Do not delete a lock while a writer may still be active. For scale
or stronger recovery requirements, replace the file adapter with the control-plane
identity service rather than extending this fallback into a database.

The forum/Gun seed cache remains temporary. The forum page tells users posts and
snapshots can disappear on restart. These caches do not move into account storage.

Validation here uses separate Node processes in different container directories
sharing one explicit store, and tests path/mount validation and writer contention.
That establishes application behavior; Azure redeploy/recycle acceptance remains
pending.
