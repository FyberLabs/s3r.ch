# Dependabot and transitive CVE pins

Weekly Dependabot version updates are configured in [`.github/dependabot.yml`](../.github/dependabot.yml): `npm` and `github-actions` at `/`, Tuesday 07:00 America/Los_Angeles, grouped (production vs development npm; all Actions). Limit is 10 open PRs. Security updates stay on in repo settings. Do not ignore `axios` or `@faker-js/faker`.

## Why `package.json` overrides exist

Neither package is a direct app dependency. Dependabot security updates failed with `security_update_not_possible` because upstream still pins vulnerable ranges:

- `@faker-js/faker` — `@farcaster/core@0.20.0` requires `^7.6.0`. Lowest patched is `10.5.0`. Farcaster outbound (`lib/farcaster-outbound.ts`) only uses signing APIs (`makeCastAdd`, `NobleEd25519Signer`, `Message`), not the faker factories bundled in `@farcaster/core`.
- `axios` — `@coinbase/cdp-sdk@1.55.0` (via `@walletconnect/ethereum-provider` / wagmi) requires `1.16.0`. Lowest patched is `1.18.0`.

`overrides` force `axios@>=1.18.0` and `@faker-js/faker@>=10.5.0` so the lockfile installs patched versions without dropping Farcaster outbound or WalletConnect.

Revisit and drop the overrides when those upstreams publish releases that accept the patched ranges. Do not rip out `@farcaster/core` or WalletConnect to clear the alerts.
