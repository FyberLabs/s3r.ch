# SEA grant, view and revoke nightly

`node scripts/test-sea-grants-browser.mjs` is an isolated browser scenario registered
in the Infra nightly. It requires GitHub Actions with the `schedule` event. It does not inspect
shared TEST fixtures or provision accounts. A failed scheduled run becomes a linked
follow-up issue; it is not a deployment qualification or merge prerequisite.

The scenario uses the real `PostSeeGrantControls`, `SeeAclProvider`, local IndexedDB
persistence, grant preparation/delivery/retraction, `Check see` and Granted tab
projection helpers. Its rendered inbox is simplified; it does not mount the full
FeedStream Granted UI. It checks recipient wallet refusal, a SEA grant, recipient visibility,
the same SEA principal under another linked-login label, wallet-only viewer refusal,
and immediate revocation across both linked-login labels.

The fixture substitutes an in-memory Gun transport and a viewer-principal selector
for hosted peer transport and authenticated sessions. It generates two ephemeral
P-256 public identities per run; no shared identity, wallet or OAuth provider is
contacted. The buttons substitute session principals; they are not real login actions.
The selector tests continuity after session resolution, not linked-login issuance. `lib/forum-route.test.ts` independently exercises the existing SEA JWT
reader and rejects wallet/OIDC-only and mixed delegated credentials.

Legacy feed grant delivery remains its existing unsigned wire format. This scenario
does not claim signed grant admission. Canonical signed forum authority and scoped
agent delegation keep their separate verification contracts and tests.

Lifecycle: build the browser bundle in memory, bind one random loopback port, create
a fresh browser context, and wait for the grant form as readiness. All requests must
stay on that loopback origin. No filesystem fixture or backend object is created.
The `finally` block closes the browser (removing its ephemeral IndexedDB/session
state) and the listener on success or failure. Runner termination reclaims process
memory and the loopback socket after an interrupted run. Package installation and
browser availability use the nightly runner's existing setup.

The JSON report lists each named case as passed, failed or blocked. Failure output
contains static status only, never browser error details or captured URLs.
