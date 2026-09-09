/**
 * Third-party KYC attestation adapter. Proves a claim to the holder.
 * Not AML, not a passport product, not uniqueness theater.
 * Fixture issuer is a swap-in stub. A real issuer is env-gated and
 * fails closed as "not configured" when unset.
 */

import { getAddress } from "viem";
import {
  kycClaimId,
  normalizeKycIssuer,
  normalizeKycSubject,
  parseKycLookup,
} from "./held-claims";
import { sessionAddressOrNull } from "./confirm";

export const FIXTURE_KYC_ISSUER = "fixture";
export const FIXTURE_KYC_SUBJECT = "held";

export type KycAttestOk = {
  ok: true;
  claimId: string;
  issuer: string;
  subject: string;
};

export type KycAttestResult =
  | KycAttestOk
  | { notConfigured: true }
  | { denied: true; reason: string };

export type KycIssuer = {
  id: string;
  label: string;
  attest(input: {
    address: string;
    subject?: string;
  }): Promise<KycAttestResult>;
};

export function kycIssuerUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.KYC_ISSUER_URL?.trim();
  return raw || null;
}

export function createFixtureKycIssuer(): KycIssuer {
  return {
    id: FIXTURE_KYC_ISSUER,
    label: "Lab",
    async attest(input) {
      let address: string;
      try {
        address = getAddress(input.address);
      } catch {
        return { denied: true, reason: "invalid address" };
      }
      void address;
      const subject = normalizeKycSubject(input.subject ?? FIXTURE_KYC_SUBJECT);
      if (!subject) return { denied: true, reason: "invalid subject" };
      return {
        ok: true,
        issuer: FIXTURE_KYC_ISSUER,
        subject,
        claimId: kycClaimId(FIXTURE_KYC_ISSUER, subject),
      };
    },
  };
}

export function createHttpKycIssuer(id: string, url: string): KycIssuer {
  const issuer = normalizeKycIssuer(id) ?? "env";
  return {
    id: issuer,
    label: issuer,
    async attest(input) {
      let address: string;
      try {
        address = getAddress(input.address);
      } catch {
        return { denied: true, reason: "invalid address" };
      }
      const subject = normalizeKycSubject(input.subject ?? FIXTURE_KYC_SUBJECT);
      if (!subject) return { denied: true, reason: "invalid subject" };
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, subject, issuer }),
        });
        if (!response.ok) return { denied: true, reason: "issuer denied" };
        const body = (await response.json()) as {
          subject?: string;
          claimId?: string;
        };
        const parsed = body.claimId
          ? parseKycLookup(body.claimId)
          : { issuer, subject: normalizeKycSubject(body.subject ?? subject) };
        if (!parsed || !parsed.subject) {
          return { denied: true, reason: "issuer denied" };
        }
        return {
          ok: true,
          issuer: parsed.issuer,
          subject: parsed.subject,
          claimId: kycClaimId(parsed.issuer, parsed.subject),
        };
      } catch {
        return { denied: true, reason: "issuer denied" };
      }
    },
  };
}

export function createNotConfiguredKycIssuer(id = "env"): KycIssuer {
  return {
    id,
    label: id,
    async attest() {
      return { notConfigured: true };
    },
  };
}

/** Fixture when no issuer URL. Swap the HTTP issuer in when Chris sets one. */
export function activeKycIssuer(
  env: NodeJS.ProcessEnv = process.env,
): KycIssuer {
  const url = kycIssuerUrl(env);
  return url ? createHttpKycIssuer("env", url) : createFixtureKycIssuer();
}

export function kycIssuers(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, KycIssuer> {
  const issuers: Record<string, KycIssuer> = {
    [FIXTURE_KYC_ISSUER]: createFixtureKycIssuer(),
  };
  const url = kycIssuerUrl(env);
  issuers.env = url
    ? createHttpKycIssuer("env", url)
    : createNotConfiguredKycIssuer("env");
  return issuers;
}

export type KycHttpOk = {
  status: 200;
  body: { claimId: string; issuer: string; subject: string };
};

export type KycHttpResult =
  | KycHttpOk
  | { status: 200; body: { status: "not_configured"; error: "not configured" } }
  | { status: 400 | 401; body: { error: string } };

/**
 * Session-gated attestation. Issuer APIs are UrlLeaf until dest admits
 * the claim id onto the overlay. Do not invent a missing issuer.
 */
export async function attestKycForSession(params: {
  sessionAddress: string | null | undefined;
  issuerId?: unknown;
  subject?: unknown;
  issuers: Record<string, KycIssuer>;
}): Promise<KycHttpResult> {
  const address = sessionAddressOrNull(params.sessionAddress);
  if (!address) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  const requested =
    typeof params.issuerId === "string" && params.issuerId.trim()
      ? params.issuerId.trim().toLowerCase()
      : FIXTURE_KYC_ISSUER;
  const issuer = params.issuers[requested];
  if (!issuer) {
    return {
      status: 200,
      body: { status: "not_configured", error: "not configured" },
    };
  }

  const subject =
    typeof params.subject === "string" ? params.subject : FIXTURE_KYC_SUBJECT;
  const result = await issuer.attest({ address, subject });
  if ("notConfigured" in result) {
    return {
      status: 200,
      body: { status: "not_configured", error: "not configured" },
    };
  }
  if ("denied" in result) {
    return { status: 400, body: { error: result.reason } };
  }
  return {
    status: 200,
    body: {
      claimId: result.claimId,
      issuer: result.issuer,
      subject: result.subject,
    },
  };
}
