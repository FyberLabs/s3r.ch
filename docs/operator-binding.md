# Reciprocal operator binding

`verifyOperatorBinding` in `lib/identity/operator-binding.ts` verifies public
operator declarations for Infra #1261. The trusted caller supplies the configured
domain, checksummed wallet and existing SEA public key independently of evidence.
There is no wallet-wide lookup or old ACL history import.

Each closed-schema record has `version: 1`, `domain`,
`purpose: "s3rch-operator-binding/v1"`, `wallet`, `sea_public_key`, `timestamp`,
`wallet_signature`, and `sea_signature`. Timestamp is an integer Unix second
recording the binding event; it does not expire on a schedule.

The exact signing text is UTF-8, six lines joined with LF and no trailing LF:

```
s3rch-operator-binding/v1
role=wallet-to-sea
domain=test.s3r.ch
wallet=<checksummed wallet>
sea_public_key=<SEA public key>
timestamp=<decimal Unix second>
```

The reciprocal statement changes only `role=sea-to-wallet`. Use
`operatorBindingStatement` to construct the bytes. The wallet proof is a 65-byte
EIP-191 EOA signature encoded as 0x hex. The SEA proof uses the existing SEA P-256
signing key: SHA-256 over these bytes, compact 64-byte r||s, unpadded base64url,
verified through SociACL. This is not a Gun `SEA{...}` envelope. Contract-wallet
signatures are not supported by this offline v1 contract and refuse.

The operator signs both statements deliberately once; CI only verifies them.
No production signer or private-key loader is included. The test suite uses
synthetic keys solely to generate unit vectors. Public declarations can be
checked in; no actual operator declaration or proof is supplied by this change.

The verifier accepts a bounded array of public records, rejects duplicate wallet
rows (including case aliases and conflicting keys), and compares every selected
field against trusted configuration before returning an immutable binding.
It returns null for refusal without echoing proof details. To change the binding,
update the trusted declaration deliberately and provide both new signatures.
There is no newest-key choice or fallback to an older declaration.

This proof is not login, ACL enrollment, a reader grant or a provisioning receipt.
The private fixture delivery and registered hosted driver remain Infra work.
Installation and activation remain off.
