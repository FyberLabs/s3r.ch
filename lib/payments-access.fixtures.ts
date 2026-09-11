/**
 * Panopticon payments access JSON fixtures. Shape matches
 * `products/payments/docs/payments-access-v0.md`. No live secret.
 */

export const PAYMENTS_RESOURCE = "content:essay:welcome";
export const PAYMENTS_TX_REF = "0xreceiptstub";
export const PAYMENTS_AMOUNT = "1.00";
export const PAYMENTS_INTENT_ID = "pay_ab12stub";
export const PAYMENTS_PAY_TO = "0x1111111111111111111111111111111111111111";
export const PAYMENTS_EXPIRES_AT = "2026-09-09T14:05:00+00:00";
export const PAYMENTS_ACCESS_UNTIL = "2026-09-09T15:05:00+00:00";

export const INTENT_OK_BODY = {
  ok: true,
  status: "quoted" as const,
  intentId: PAYMENTS_INTENT_ID,
  resource: PAYMENTS_RESOURCE,
  asset: "USDC" as const,
  amount: PAYMENTS_AMOUNT,
  payTo: PAYMENTS_PAY_TO,
  memo: PAYMENTS_INTENT_ID,
  expiresAt: PAYMENTS_EXPIRES_AT,
  upstream: "mock",
};

export const INTENT_UNAVAILABLE_BODY = {
  ok: false,
  status: "unavailable" as const,
  intentId: null,
  resource: "content:held:lab",
  asset: "USDC" as const,
  amount: null,
  payTo: null,
  memo: null,
  expiresAt: null,
  upstream: "mock",
};

export const RECEIPT_OK_BODY = {
  ok: true,
  status: "verified" as const,
  resource: PAYMENTS_RESOURCE,
  accessUntil: PAYMENTS_ACCESS_UNTIL,
  upstream: "mock",
};

export const RECEIPT_NOT_FOUND_BODY = {
  ok: false,
  status: "not_found" as const,
  resource: PAYMENTS_RESOURCE,
  accessUntil: null,
  upstream: "mock",
};

export const RECEIPT_UNVERIFIED_BODY = {
  ok: false,
  status: "unverified" as const,
  resource: PAYMENTS_RESOURCE,
  accessUntil: null,
  upstream: "mock",
};

export const RECEIPT_EXPIRED_BODY = {
  ok: false,
  status: "expired" as const,
  resource: PAYMENTS_RESOURCE,
  accessUntil: null,
  upstream: "mock",
};

export const RECEIPT_ERROR_BODY = {
  ok: false,
  status: "error" as const,
  resource: PAYMENTS_RESOURCE,
  accessUntil: null,
  upstream: "error",
};

export const RECEIPT_BAD_VERIFIED = {
  ok: true,
  status: "verified" as const,
  resource: PAYMENTS_RESOURCE,
  accessUntil: "not-a-date",
  upstream: "mock",
};

export const HOP_ENV = {
  PANOPTICON_PAYMENTS_BASE: "https://api.test.hyperme.sh",
  PANOPTICON_TENANT_ID: "11111111-2222-4333-8444-555555555555",
  PANOPTICON_API_KEY: "s3rch.lab-not-a-real-key",
};
