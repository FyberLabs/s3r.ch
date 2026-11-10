@AGENTS.md

## Service deployments and binary provenance

Each TEST service automatically tracks the latest PR merged into its repository's default branch. Deploy the tested build through a moving TEST channel. Do not pin running services to versions, commit SHAs or image digests, require manual pin updates, or require peer services to run matching builds. Preserve patch compatibility, including during early development, and verify it through the service contract.

Use exact versions and digests for downloadable bundles and to record or verify which binary was built, tested or released. A running service may report its revision for diagnostics. Production follows its existing promotion policy and explicit release authorization.
