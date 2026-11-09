<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Service deployments and binary provenance

Each TEST service automatically tracks the latest PR merged into its repository's default branch. Deploy the tested build through a moving TEST channel. Do not pin running services to versions, commit SHAs or image digests, require manual pin updates, or require peer services to run matching builds. Preserve patch compatibility, including during early development, and verify it through the service contract.

Use exact versions and digests for downloadable bundles and to record or verify which binary was built, tested or released. A running service may report its revision for diagnostics. Production follows its existing promotion policy and explicit release authorization.
