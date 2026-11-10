<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Service deployments and binary provenance

Running services follow a version tag and pick up patches on that line. They are patch-compatible within a minor version. Deploy the minor line, for example `ghcr.io/fyberlabs/s3r.ch:1.4`, or a moving channel tag such as `ghcr.io/fyberlabs/s3r.ch:test` for TEST. Do not deploy a running service by image digest, commit SHA, or a frozen patch tag. Do not require a peer service to run one identical build. A running service may report its revision for diagnostics.

Each code change gets a new patch version. A downloadable package is referenced by that version, not by a hash.

A digest may be recorded to verify which image a tag resolved to. It is not the reference used to deploy.

TEST follows `ghcr.io/fyberlabs/s3r.ch:test`, which advances when a build from the default branch is published. A new minor line for production is an explicit release choice. Patches inside the current minor line arrive through the minor tag.
