# Delegated media reads

`POST /api/media/read-wrap` accepts the existing agent issuer's bearer tokens
with the `media:read` scope. The issuer checks current signed delegation,
revocation and expiry on every authentication. The request still supplies the
canonical same-site Origin and an object-only JSON body.

Both the delegator and the agent must have independently provisioned entries in
`S3RCH_MEDIA_READER_BINDINGS`. Each credential remains bound to its own ACL
subject. The server reads the delegator's wrap, the agent's wrap, and the
delegator's wrap again. All must be current and describe the same object, epoch
and revision. Only the agent's encrypted wrap is returned. The delegator's wrap
is an entitlement check, never a substitute output or an agent credential.
Delegation is rechecked throughout and immediately before delivery. These are
bounded sequential observations, not an atomic cross-subject ACL transaction;
the existing short wrap expiry remains in force.

An Authorization header selects the agent path exclusively. Invalid or revoked
tokens cannot fall back to an ambient browser owner cookie. Agent calls to
catalog, owner, group, consent and mutation paths are refused; `media:read`
does not authorize writes, sharing, granting or ACL changes. Those consumers
require separate scoped contracts.

This source change provisions no identity or credentials and enables no TEST
fixture. Shared owner/reader scenarios remain unregistered until their genuine
operator-owned identities and corresponding owner contracts exist. Unit tests
use mocked issuer/ACL responses, not shared fixtures or live identity proofs.
