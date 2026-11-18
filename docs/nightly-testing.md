# Nightly integration and E2E tests

Runtime acceptance runs in the single scheduled FyberLabs/infra nightly batch.
The registry is `config/nightly/suites.json` in infra; its runner checks out
current s3r.ch master and records the tested revision. Do not dispatch or rerun
the full suite manually, or run it against shared resources from a workstation.

| Adapter | Coverage |
| --- | --- |
| s3rch-browser | Chromium static feed and standalone startup |
| s3rch-peer | Gun persistence, two-client reconnect and peer restart |
| s3rch-sign-in | Proxied wallet sign-in and Squad challenge |
| s3rch-assignment | Multi-client assignment, revocation and restart recovery |
| s3rch-storage | Blob conditional writes and emulator restart recovery |

Each adapter runs independently so a failed suite does not suppress the others.

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

### Peer canary rehearsal

The Infra-owned canary fixture supplies distinct baseline and candidate builds.
The scheduled peer canary checks the exact served revision, then exercises the
packaged Gun process with separate Chromium contexts. It starts the baseline,
stops it before the candidate takes the disposable volume, and restores the
baseline after the candidate writes. Existing clients must reconnect and fresh
clients must read the last value. The isolated rehearsal uses the peer's origin
routes. The production adapter attributes the peer through `/_peer/api/version`
and `/_peer/api/health` at public ingress without performing writes there.
