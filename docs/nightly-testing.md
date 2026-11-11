# Nightly integration and E2E tests

Runtime acceptance runs in the single scheduled FyberLabs/infra nightly batch.
The registry is `config/nightly/suites.json` in infra; its runner checks out
current s3r.ch master and records the tested revision. Do not dispatch or rerun
the full suite manually, or run it against shared resources from a workstation.

| Adapter | Coverage |
| --- | --- |
| s3rch-browser | Chromium static feed, Gun persistence/reconnect, proxied sign-in, Squad challenge, multi-client assignment/revocation/restart, standalone startup |
| s3rch-storage | Blob conditional writes and emulator restart recovery |

PR CI keeps unit/contract tests, upstream SociACL contract verification, builds,
and the existing image smoke. Each issue fix needs regression coverage for its
changed behavior, including denial cases where access or identity is affected.

Infra retains per-command JSON/JUnit results and redacted diagnostics, reports
missing evidence as failure, and tracks recurring failures. Inspect the scheduled
results there; a green build alone does not establish runtime acceptance.

These isolated suites use synthetic identities and disposable local resources.
They do not establish shared TEST or production acceptance, or cover the planned
meeting and media products. Shared TEST suites require infra-owned fixtures and
readiness verification before registration.
