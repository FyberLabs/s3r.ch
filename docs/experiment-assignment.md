# Experiment assignment adapter

`createExperimentState` is the server-only assignment adapter for #337. It accepts
an authenticated SEA principal from the session verifier, the request cookie
header, and a bounded set of active experiment definitions. Its provider callback
receives a keyed assignment hash. Assignment remains stable across release versions and colors.

The adapter emits a random UUID in `__Host-s3rch-experiment-id` and authenticated
cohort state in `__Host-s3rch-experiments`. Both cookies use Secure, HttpOnly,
SameSite=Lax and Path=/ with no Domain. The signing/hash secret must be random,
at least 32 bytes and shared across web instances for the assignment window.
Cookie state expires after one year. The application must append both returned
Set-Cookie values to the response after awaiting its evaluations.

An anonymous cohort survives the first sign-in. Later experiments use the verified
SEA identity's keyed hash; retained experiments keep their original cohort hash.
Logout or switching accounts discards the previous person's assignments. Removed
experiments are pruned, and at most eight active experiments fit the cookie budget.
An expired, invalid or unverifiable state token starts fresh state.

A provider error or unknown variant returns the compiled control without saving
an assignment. A failed guardrail overrides the returned variant to control while
retaining the cohort for attribution. The caller supplies the authoritative shared
guardrail result. This library does not collect metrics or change a deployment.

Evaluation does not emit events. Use the first-party event adapter only when a
response actually shows a variant or the configured conversion occurs. Experiment
and variant names are configuration slugs, never customer content. The SEA key,
UUID, cookies, request headers and raw errors never enter event payloads.

This adapter is not yet registered on application routes. OpenFeature/GrowthBook
payload handling, verified-session wiring, first-party transport and shared
metric-driven guardrail disabling remain part of #337.

## OpenFeature and GrowthBook provider

`createExperimentProvider` evaluates through the OpenFeature server SDK and its
GrowthBook provider. Give the adapter one dedicated OpenFeature domain and an
operator-configured public Ed25519 key. The signer belongs to the control plane;
the web process receives only its public key. No key is accepted from a request.

`refresh(raw, signature)` verifies a detached base64url Ed25519 signature over the
exact UTF-8 JSON bytes before parsing. The bounded payload has exactly these
fields: `version: 1`, `audience: "s3r.ch"`, positive monotonic `sequence`, epoch-second
`issuedAt` and `expiresAt`, and `experiments`. Validity is at most seven days.
Each experiment has `key`, `control`, `variants`, `weights` (summing to one), and
`disabled`. Extra targeting attributes and demographic conditions are refused.

A bad signature, malformed payload, stale sequence or failed refresh retains the
last valid configuration until its expiry. Before the first payload or after
expiry, definitions are empty and evaluation falls back to the caller's compiled
control. A signed disable supplies the shared guardrail override to the state
adapter. The provider itself does not collect or aggregate metrics.

Only a keyed assignment hash enters GrowthBook's targeting context. The SDK uses
an in-memory payload with networking, streaming and analytics callbacks absent.
The application controls first-party exposure/conversion emission separately.

Payload signing/delivery, the shared guardrail controller and route registration
are still needed before this provider enables experiments in the application.
