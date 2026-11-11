# Request origin trust

`lib/request-origin.ts` consumes normalized ingress metadata. It does not
identify a trusted proxy from the presence of `X-Forwarded-*` headers.

For deployed TEST and production, the owning Infra configuration authenticates
the Cloudflare-to-App-Service path, denies direct site and SCM ingress, and
replaces caller-supplied forwarded host and protocol with the canonical public
host and HTTPS scheme. This is the boundary tracked in
[FyberLabs/infra#741](https://github.com/FyberLabs/infra/issues/741) and
[#759](https://github.com/FyberLabs/infra/pull/759).

`requestHost` supplies SIWE's request-domain comparison. `requestIsSecure`
selects Secure `__Host-` identity cookies after TLS termination. Neither helper
can compensate for an unauthenticated origin or an edge that preserves attacker
forwarding metadata. Adding another proxy or origin requires the same ingress
restriction and header replacement in its owning deployment configuration.

Squad browser writes additionally require the configured canonical Origin,
matching public Host and forwarded host, and the exact forwarded HTTPS protocol.
A forwarding header alone cannot authorize a browser write. Direct localhost
identity development uses its actual host/port and HTTP cookies; it does not
turn a localhost request into an authorized production Squad request.

Unit/contract coverage lives in `lib/request-origin.test.ts`,
`lib/identity/request-origin-contract.test.ts`, and
`lib/identity/squad-session-http.test.ts`. The scheduled central nightly
`s3rch-sign-in` adapter exercises the actual local proxy and Next transport.

The Infra-owned `scripts/s3rch/check-origin-headers.py` is the anonymous live
negative-signature probe: spoofed client forwarding headers must still produce
a Secure nonce cookie and reach invalid-signature rejection for the canonical
SIWE domain. It creates no authenticated session. Any shared TEST execution
belongs in the scheduled central batch with its declared fixture/readiness;
do not run the probe by hand. Unit tests do not establish deployed ingress
acceptance. Issue #291 remains open until its deployment evidence is recorded.
