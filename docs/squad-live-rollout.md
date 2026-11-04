# Squad live rollout (#190)

PR #218 completed assignment/access integration and isolated synthetic acceptance
for #188. Production rollout remains separate. The public `/feed/squad` route
continues to render the demo; it does not obtain live authority by changing a
fixture constant or URL parameter.

## Namespace isolation

`SquadForum` accepts an optional `LiveSquadSpec` (`forumId`, stable SEA `owner`,
`label`) from its provisioned application wrapper. Omitting it selects the demo.
Malformed live configuration throws instead of falling back to demo identities.
The forum ID must embed its declared owner, and neither the public demo namespace
nor any known fixture principal can be used as a live owner.

Live mode starts with empty roster, chat, needs and alarm state. It never creates
the sample ACL, admits the sample roster, uses sample labels, or restores sample
keys for signing. Known fixture principals are excluded from proof verification
and signing even if a source supplies records for them. A separately provisioned
`ForumAuthorityProvider` must supply complete authenticated history and signed
ACL evidence; namespace selection itself grants nothing. Receive readiness also
requires that verified forum ownership matches the configured owner.

The component remounts on a change of mode, forum or owner. This disposes prior
subscriptions, proof generations, pending work and drawer state. Need/status
high-water marks and alarm floors use separate `s3rch:squad:v2:<mode>:<forum>:<owner>`
keys. The old global cache keys are not imported into a live namespace. Cached
rows remain replay hints, never authenticated content or ownership.

No production route or environment setting selects a live namespace yet. There
are no new deployment variables in this step. The existing public demo is the
rollback/default path; returning to it mounts fresh demo state rather than
carrying live state into a fixture view.

## Remaining production gates

- Provision a fresh controlled owner and namespace, and persist the authoritative
  journal, inventories and immutable signed records in operator-owned storage.
- Bind authenticated sessions to current SEA principals. Wallet/OAuth identities
  are linked credentials, not replacements for SEA authority.
- Supply complete history, explicit witness trust and SIWE/OIDC policy. Serialize
  history changes with assignment mutations or reject stale generations at the
  sink. Preserve cancellation witnesses across key retirement.
- Connect the live wrapper, authority source and assignment client to actual
  production APIs. Register every destination through the shared journal.
- Implement configuration in the app and infra/config together, documenting
  defaults and owners. Validate actual deployment before enabling the route.
- Verify the deployed multi-client matrix in #190: chat, status, drawer records,
  needs/offers, alarm, assignment/access, recovery, revoked writers and reconnect.

The namespace and empty-state tests are consumer isolation evidence, not proof of
production history completeness, provisioning, deployment or live acceptance.
