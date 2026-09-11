/**
 * Panopticon attest JSON fixtures. Shape matches
 * `products/oracles/docs/oracles-attest-v0.md`. No live secret.
 */

export const ATTEST_OBSERVED_AT = "2026-09-09T03:36:00+00:00";

export const ATTEST_SUBJECT = "eas:uid:0xatteststub";
export const ATTEST_MISSING_SUBJECT = "eas:uid:0xmissing";
export const ATTEST_RELAY_SUBJECT = "https://relay.test.example/health";

/** sha256("test") — same digest as the integrator-doc example. */
export const ATTEST_DIGEST =
  "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

export const ATTEST_OK_BODY = {
  ok: true,
  kind: "public_attestation" as const,
  subject: ATTEST_SUBJECT,
  status: "observed" as const,
  observedAt: ATTEST_OBSERVED_AT,
  digest: ATTEST_DIGEST,
  upstream: "mock",
};

export const ATTEST_NOT_FOUND_BODY = {
  ok: false,
  kind: "public_attestation" as const,
  subject: ATTEST_MISSING_SUBJECT,
  status: "not_found" as const,
  observedAt: ATTEST_OBSERVED_AT,
  digest: null,
  upstream: "mock",
};

export const ATTEST_RELAY_OK_BODY = {
  ok: true,
  kind: "public_relay" as const,
  subject: ATTEST_RELAY_SUBJECT,
  status: "observed" as const,
  observedAt: ATTEST_OBSERVED_AT,
  digest: ATTEST_DIGEST,
  upstream: "http",
};

export const ATTEST_BAD_OBSERVED_AT = {
  ...ATTEST_OK_BODY,
  observedAt: "not-a-date",
};

export const ATTEST_OK_WITHOUT_DIGEST = {
  ...ATTEST_OK_BODY,
  digest: null,
};

export const ATTEST_HOP_ENV = {
  PANOPTICON_ORACLES_BASE: "https://api.test.hyperme.sh",
  PANOPTICON_TENANT_ID: "11111111-2222-4333-8444-555555555555",
  PANOPTICON_API_KEY: "s3rch.lab-not-a-real-key",
};
