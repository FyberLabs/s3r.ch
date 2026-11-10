@AGENTS.md

## Service deployments and binary provenance

Running services follow a version tag and pick up patches on that line. They are patch-compatible within a minor version. Deploy the minor line, for example `ghcr.io/fyberlabs/s3r.ch:1.4`, or a moving channel tag such as `ghcr.io/fyberlabs/s3r.ch:test` for TEST. Do not deploy a running service by image digest, commit SHA, or a frozen patch tag. Do not require a peer service to run one identical build. A running service may report its revision for diagnostics.

Each code change gets a new patch version. A downloadable package is referenced by that version, not by a hash.

A digest may be recorded to verify which image a tag resolved to. It is not the reference used to deploy.

TEST follows `ghcr.io/fyberlabs/s3r.ch:test`, which advances when a build from the default branch is published. A new minor line for production is an explicit release choice. Patches inside the current minor line arrive through the minor tag.
