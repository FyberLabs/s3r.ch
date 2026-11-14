# Keycloak credentials and SEA identity

A person has one SEA principal. Wallet addresses and Keycloak accounts are
credentials linked to that identity; neither a checksummed wallet address nor a
Keycloak subject is a Check owner. Feed ownership, grants and authenticated forum
operations use the SEA identity described in [identity.md](identity.md#current-ownership-model-277-443-444).
Changing a credential must not create an identity or merge two existing identities.

## Current implementation

The existing `/api/identity/oauth/start` and `/api/identity/oauth/callback` routes
provide the backup OAuth credential flow. They use the configured provider,
PKCE, state and an exact registered callback URI. The backup cookie contains
credential metadata, not provider tokens or SEA authority. Existing wallet-handoff
and legacy handle-link records do not establish a signed SociACL link or grant
access to an owner's objects. An unlinked OAuth account is not an owner.

The startup callback is a separate flow for an independently declared existing
SEA identity. Its mapping and broker metadata are not general signed-link login
proofs. The operator's reciprocal wallet/SEA declaration likewise establishes
only its fixed startup binding; it does not admit a Keycloak login or enroll an
account into an ACL history source.

## Signed-link login (#444)

`createIdentitySessions` is the single SEA-session issuer. Its
`/api/identity/sea/linked-challenge` and `linked-exchange` handlers verify the
SociACL signed-link contract and issue the same five-minute SEA-subject session
used by existing-key login. Credential cookies cannot substitute for this session.

OIDC admission requires all of the following:

- A trusted source enumerating every eligible link for the exact issuer, tenant
  and subject, with authenticated current histories and revocations. Zero or
  multiple eligible identities refuse login.
- A fresh ID token from the configured issuer and verification key resolver,
  with the exact client audience, tenant claim and subject. Email and display
  names are not account selectors.
- The linked challenge nonce and an `auth_time` no earlier than that challenge,
  plus the matching browser challenge cookie and origin. Replay, expiry,
  revocation and key changes are checked by the issuer.

The hosted linked endpoints currently return `503 linked-identity-unavailable`:
no complete owning credential/history source is installed. The existing backup
OAuth callback does not yet orchestrate this fresh challenge-bound OIDC exchange.
A historical local wallet export, a startup mapping or a boolean configuration
flag cannot fill either gap. The linked-wallet browser controller is implemented,
but provider event wiring and session UI integration remain separate work.

See [signed-link admission](linked-session-admission.md) for the implemented
verifier, browser controller, source bounds and isolated CI coverage. Lost-key
recovery additionally needs the shared recovery policy and authenticated rotation
publication contract; login does not reconstruct private keys. #444 remains open
until its remaining source, provider and recovery integration is implemented.

## Keycloak client and brokers

The default backup provider uses Panopticon Keycloak's `controlplane` realm and
the public PKCE client `s3rch-web`. s3r.ch is a client of that IdP, not a second
Keycloak deployment. The existing broker aliases are `microsoft`, `github` and
`google`; their upstream callbacks remain on the Keycloak host.

The application's exact callback URIs are declared in
`lib/identity/config.ts` as `OAUTH_REDIRECT_URIS`. Keep the Keycloak client
registration consistent with that list. A missing or invalid provider
configuration refuses the OAuth flow. Tokens must not be published to Gun or
persisted in the credential cookie.

The Hypermesh wallet handoff can suggest connecting an already bound wallet.
It is credential coordination only: accepting or declining that suggestion does
not create a SEA key, establish signed-link authority or change object ownership.
