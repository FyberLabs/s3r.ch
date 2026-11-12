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
