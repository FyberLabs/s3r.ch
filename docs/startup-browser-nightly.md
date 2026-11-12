# Startup linked-login browser qualification

The central Infra nightly matrix owns execution and private fixture staging. Registration is tracked by FyberLabs/infra#942 and #923. Run `node scripts/test-startup-linked-login.mjs` only in that scheduled matrix; do not dispatch it manually or run it on a workstation. The script returns exit 78 with a redacted blocked result when context or private inputs are absent.

The guard requires `GITHUB_ACTIONS=true`, `GITHUB_EVENT_NAME=schedule`, `GITHUB_WORKFLOW_REF=FyberLabs/infra/.github/workflows/nightly-integration.yml@refs/heads/main`, `NIGHTLY_SUITE=startup-linked-browser`, and the owner checkout metadata `GITHUB_REPOSITORY=FyberLabs/s3r.ch`, `GITHUB_REF=refs/heads/master`.

`NIGHTLY_STARTUP_BROWSER_FIXTURE_FILE` points to a private owned regular file (0600, no symlink or additional hard link, at most 64 KiB). Infra stages it from the separate browser secret and removes it afterward. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` may select the central runner's Chromium. The raw owner orchestration bundle must not enter this browser case or the frontend build.

The exact closed schema is validated in `scripts/startup-browser-fixture.mjs`:

- `version`: 1; `site_origin`: the configured HTTPS TEST origin.
- `sea_record`: an explicitly supplied existing TEST IndexedDB record with `address`, `seaPub`, `seaPair` (`pub`, `priv`, `epub`, `epriv`), `walletSignature`, and `signedPayload`.
- `expected`: configured `sea_public_key`, `person_id`, `tenant_id`, three distinct `organization_ids`, `binding_sha256`, and `mapping_sha256`.
- `negative_organization_id`: a declared UUID outside those three organizations.
- `login`: `driver: "form-v1"`, explicit HTTPS provider `origins`, `credentials` containing only the needed `username`, `password`, or `otp`, and ordered form `steps`. A fill step has `action: "fill"`, `origin`, `selector`, and `credential` naming one supplied credential. A click step has `action: "click"`, `origin`, and `selector`.

Use only designated TEST credentials and an explicitly supported MFA path. No access-token injection, authenticated storage state, substitute administrator, generated identity, or shared-data reset is supported. Missing credentials remain blocked.

A fresh isolated browser stages the supplied existing SEA record, completes the actual provider redirect and form login, checks the exact linked person and immutable scopes, rejects an undeclared organization selection, then signs out and signs in again. It verifies that the entire saved SEA record remains unchanged. The browser emits only redacted case/status JSON; it does not save provider traces, screenshots, or credential-bearing responses. The login metadata grants no mesh or owner action; server authorization remains with the owning services.
