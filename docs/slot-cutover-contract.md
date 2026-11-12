# Web slot compatibility

Both web colors use the same `IDENTITY_SESSION_SECRET` and canonical public
origin. The secret is shared configuration, not a slot-specific setting; a color
switch must not rotate it. Keep cookie name, path, domain, secure flags, issuer
and audience stable. Wallet cookie tests exercise both directions between two
instances. SEA session tests already exercise cross-instance verification and
global challenge consumption. The replay store must remain shared as well;
sharing a signing secret does not make independent replay stores safe.

`/api/version` remains no-store and reports the image's validated build revision,
not a request header or mutable client claim. Compare it with the tag's built
revision before a canary window. Running TEST continues to follow its moving
channel. No release promotion or production tag is introduced by this contract.

`/api/health` remains HTTP 200 while serving. Inspect identity and dependency
fields separately. Gun keeps `status: external` for existing consumers and adds
`health: ok | unavailable | not-configured` and `checkedAt`. Configure
`S3RCH_GUN_HEALTH_URL` with the external peer probe; an HTTP 200 alone is not
healthy unless its JSON confirms `dependencies.gun.status: ok`. Results are
cached for 15 seconds, concurrent checks share a request, redirects are refused,
and probe time/body size are bounded. A missing setting does not claim health.
A canary requiring Gun must require `health: ok` and a recent check.

Identity and forum documents remain version 1. Deploy readers that understand
an additive field to **both** colors before any writer emits that field. Existing
parsers may discard unknown fields; do not assume an arbitrary new field will
survive an old writer. Keep old defaults, field meanings and optionality while
both colors run. Only after the previous color is retired may a later release
remove old fields or advance the document version. Unknown versions are refused
without overwriting the file. Tests retain legacy/minimal and expanded version-1
shapes and cover unknown-version refusal. Do not migrate data on web startup.

The forum file has one owning process. Route all forum requests from either web
color to that owner; sharing a filesystem does not make two writers safe. The
Gun peer likewise stays a single writer, independently of web color. This change
does not launch another forum/peer process or alter their routing. Preserve the
existing identity Blob compare-and-swap path, forum file ownership and Gun volume
through rollback. Release-tagged error/crash records are described in
[release diagnostics](release-diagnostics.md).
