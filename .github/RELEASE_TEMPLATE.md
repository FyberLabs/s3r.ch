## Config changes

For the initial 0.1 release, use the [configuration reference](https://github.com/FyberLabs/s3r.ch/blob/master/docs/configuration.md)
and [minimal installation guide](https://github.com/FyberLabs/s3r.ch/blob/master/docs/install-minimal.md). Panopticon remains
optional. Preserve `/app/data` across container replacements. Set
`IDENTITY_SESSION_SECRET` to a stable secret of at least 32 characters.

Wallet sign-in also needs the durable identity storage configuration described in
the installation guide. Without it, sign-in returns 503 while the feed, forum
preview and Gun endpoint remain available. The packaged image does not include
WalletConnect configuration.

## Migration

Back up existing data before upgrading a deployment built from source. This
release does not automatically migrate external identity storage or remove
historical Gun data.

Views backups now use signed publication-specific record namespaces. Older
backups remain readable, but older clients cannot verify newly published
manifests. Upgrade all backup-writing clients before using new publications.
Legacy shared backup records are retained to avoid deleting an older client's
in-flight data. See [Views backup compatibility and limits](https://github.com/FyberLabs/s3r.ch/blob/master/docs/views-causality-limits.md).

Views operations reject oversized conflict/deletion history rather than truncate
it. Preserve the original backup or browser store if that limit is reached;
clearing history is not a recovery procedure.
