# AT and Keycloak as linked credentials

For #329, the SociACL SEA principal is the only s3r.ch identity. An AT DID/handle
or a Keycloak subject is a linked login/recovery credential, never a second
principal to create and later merge. A mutable handle is display and discovery
metadata; it cannot identify the owner of a grant, a media object or an agent.

## Login boundary

Auth owns fresh provider authentication. SociACL/ACL owns the signed link to an
existing SEA principal, current-key evaluation, revocation and recovery
eligibility. User may resolve an existing person binding. s3r.ch consumes those
contracts through its single session issuer. Matching an email, handle or display
name cannot create, select, merge or recover a principal.

The AT proof contract is tracked in
[Auth-service #54](https://github.com/hyperme-sh/auth-service/issues/54). It must
bind the verified DID, issuer and audience, tenant/client, nonce, expiry and
one-time consumption to the login transaction. AT proof is a distinct type; do
not route it through an OIDC-provider alias or treat a provider access token as
a signed SEA link. Provider tokens and DPoP private keys stay within the owning
authentication flow and never enter chat, public metadata or generic logs.

Before issuing a session, resolve exactly one current signed link from complete
trusted history. Missing, expired, revoked, ambiguous or stale linkage denies
login and creates no identity. A successful provider login alone is insufficient.
The resulting session subject is the resolved SEA principal, with the current
session key and linked-login method represented separately. Handle changes leave
the stable DID association unchanged; a changed provider subject requires a new
verified linking operation, not a string replacement.

## Linking, unlinking and recovery

Linking requires the existing SEA identity's current authorization plus fresh
proof of control of the proposed credential. The shared owner contract must
prevent a credential from silently acquiring conflicting principal links and
make the link transaction replay-safe. The UI must show the exact credential
being attached and the existing SEA identity receiving it. No automatic principal
creation is allowed when a signed link is absent.

Unlink and key rotation use the shared current-history contract. Every new login
and recovery re-evaluates eligibility rather than trusting a cached successful
login. Provider control does not by itself authorize a SEA key replacement;
recovery must satisfy the separately configured shared recovery policy. Interrupted
or uncertain linking must be reconciled against authoritative state before retry.
The browser cannot manufacture history completeness or a recovery checkpoint.

Agent JWTs come from the same unified issuer and the SEA identity's explicit
current delegation. An AT DID, Keycloak subject or successful provider refresh
cannot mint agent scopes. Delegated expiry and permissions remain bounded by
current policy and revocation, regardless of how the human authenticated.

## Browser and CI acceptance

The UI presents AT and Keycloak as linked sign-in methods for the same identity.
An unlinked login explains that no identity was selected; it must not quietly
initialize a new wallet, SEA pair or account. Logout, tenant change and a replaced
login transaction invalidate pending callbacks and clear private previews.

CI must use the real owning authentication and linkage contracts for provider
subject substitution, replay, wrong tenant/client, expired proof, handle change,
ambiguous links, unlink, key rotation and unlinked login. Browser qualification
must exercise the declared login fixtures; injected tokens or preauthenticated
state do not prove login. Agent token tests must show scopes cannot grow through
a linked credential. Provider discovery and OAuth protections remain Auth's #54
responsibility and must be qualified there before consumer activation.

Current s3r.ch recovery wire supports wallet and `oidc-fresh-login` authorizers;
it does not yet provide AT login or recovery. This document completes the
identity distinction, not runtime acceptance. #329 stays open until Auth #54 and
the shared signed-link/recovery contract are implemented and integrated. No
provider is enabled by this design.
