/**
 * Session-gated email / phone confirm. Proves the claim to the holder.
 * Never login. Never a public Gun put. PII stays off the mesh until
 * the holder explicitly shares that claim id.
 *
 * Live send is env-gated (`CONFIRM_SEND_URL`). Unset fails soft as
 * "not configured". Lab / non-production uses a documented fixture
 * code unless `CONFIRM_FIXTURE=0`.
 */

import { createHash, randomInt } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { getAddress } from "viem";
import {
  CONFIRM_TTL_SECONDS,
  FIXTURE_CONFIRM_CODE,
} from "./config";
import {
  emailClaimId,
  normalizeEmailTarget,
  normalizePhoneTarget,
  phoneClaimId,
} from "./held-claims";
import { secretKey } from "./secret";

export type ConfirmKind = "email" | "phone";

export type ConfirmSender = {
  send(input: {
    kind: ConfirmKind;
    target: string;
    code: string;
  }): Promise<{ sent: true } | { notConfigured: true } | { failed: true }>;
};

export type ConfirmChallenge = {
  address: string;
  kind: ConfirmKind;
  targetHash: string;
  codeHash: string;
  iat: number;
  exp: number;
};

export type StartConfirmOk = {
  status: 200;
  body: {
    status: "fixture" | "sent";
    kind: ConfirmKind;
    claimId: string;
  };
  challenge: ConfirmChallenge;
};

export type StartConfirmNotConfigured = {
  status: 200;
  body: { status: "not_configured"; error: "not configured" };
};

export type ConfirmHttpErr = {
  status: 400 | 401;
  body: { error: string };
};

export type StartConfirmResult =
  | StartConfirmOk
  | StartConfirmNotConfigured
  | ConfirmHttpErr;

export type VerifyConfirmResult =
  | {
      status: 200;
      body: { kind: ConfirmKind; claimId: string; method: "fixture" | "otp" };
    }
  | ConfirmHttpErr;

export function confirmFixtureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CONFIRM_FIXTURE === "1") return true;
  if (env.CONFIRM_FIXTURE === "0") return false;
  return env.NODE_ENV !== "production";
}

export function confirmSendUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.CONFIRM_SEND_URL?.trim();
  return raw || null;
}

export function notConfiguredSender(): ConfirmSender {
  return {
    async send() {
      return { notConfigured: true };
    },
  };
}

export function createHttpConfirmSender(url: string | null): ConfirmSender {
  if (!url) return notConfiguredSender();
  return {
    async send(input) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: input.kind,
            target: input.target,
            code: input.code,
          }),
        });
        if (!response.ok) return { failed: true };
        return { sent: true };
      } catch {
        return { failed: true };
      }
    },
  };
}

export function envConfirmSender(
  env: NodeJS.ProcessEnv = process.env,
): ConfirmSender {
  return createHttpConfirmSender(confirmSendUrl(env));
}

export function normalizeConfirmTarget(
  kind: ConfirmKind,
  target: string,
): string | null {
  return kind === "email"
    ? normalizeEmailTarget(target)
    : normalizePhoneTarget(target);
}

export function confirmClaimId(
  kind: ConfirmKind,
  target: string,
): string | null {
  const normalized = normalizeConfirmTarget(kind, target);
  if (!normalized) return null;
  return kind === "email" ? emailClaimId(normalized) : phoneClaimId(normalized);
}

export function hashConfirmBinding(
  address: string,
  kind: ConfirmKind,
  target: string,
  code?: string,
): string {
  const payload =
    code === undefined
      ? `${address}:${kind}:${target}`
      : `${address}:${kind}:${target}:${code}`;
  return createHash("sha256").update(payload).digest("hex");
}

export function randomConfirmCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function sessionAddressOrNull(
  sessionAddress: string | null | undefined,
): string | null {
  if (!sessionAddress) return null;
  try {
    return getAddress(sessionAddress);
  } catch {
    return null;
  }
}

export function parseConfirmKind(value: unknown): ConfirmKind | null {
  return value === "email" || value === "phone" ? value : null;
}

function challengeFor(
  address: string,
  kind: ConfirmKind,
  target: string,
  code: string,
  now: number,
): ConfirmChallenge {
  return {
    address,
    kind,
    targetHash: hashConfirmBinding(address, kind, target),
    codeHash: hashConfirmBinding(address, kind, target, code),
    iat: now,
    exp: now + CONFIRM_TTL_SECONDS,
  };
}

/**
 * Start a confirm. Session required. Does not write Gun.
 * Prefer a configured sender. Else fixture when enabled. Else honest
 * "not configured" — do not invent an issuer.
 */
export async function startHeldConfirm(params: {
  sessionAddress: string | null | undefined;
  kind: unknown;
  target: unknown;
  fixtureEnabled: boolean;
  sender: ConfirmSender;
  nowSeconds?: number;
  randomCode?: () => string;
}): Promise<StartConfirmResult> {
  const address = sessionAddressOrNull(params.sessionAddress);
  if (!address) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const kind = parseConfirmKind(params.kind);
  if (!kind) {
    return { status: 400, body: { error: "invalid kind" } };
  }
  if (typeof params.target !== "string") {
    return { status: 400, body: { error: "invalid target" } };
  }
  const target = normalizeConfirmTarget(kind, params.target);
  const claimId = target ? confirmClaimId(kind, target) : null;
  if (!target || !claimId) {
    return { status: 400, body: { error: "invalid target" } };
  }

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const code = params.randomCode?.() ?? randomConfirmCode();
  const sent = await params.sender.send({ kind, target, code });

  if (!("notConfigured" in sent) && !("failed" in sent)) {
    return {
      status: 200,
      body: { status: "sent", kind, claimId },
      challenge: challengeFor(address, kind, target, code, now),
    };
  }

  if (params.fixtureEnabled) {
    return {
      status: 200,
      body: { status: "fixture", kind, claimId },
      challenge: challengeFor(address, kind, target, FIXTURE_CONFIRM_CODE, now),
    };
  }

  return { status: 200, body: { status: "not_configured", error: "not configured" } };
}

export async function verifyHeldConfirm(params: {
  sessionAddress: string | null | undefined;
  kind: unknown;
  target: unknown;
  code: unknown;
  challenge: ConfirmChallenge | null | undefined;
  nowSeconds?: number;
}): Promise<VerifyConfirmResult> {
  const address = sessionAddressOrNull(params.sessionAddress);
  if (!address) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const kind = parseConfirmKind(params.kind);
  if (!kind) {
    return { status: 400, body: { error: "invalid kind" } };
  }
  if (typeof params.target !== "string" || typeof params.code !== "string") {
    return { status: 400, body: { error: "invalid confirm" } };
  }
  const target = normalizeConfirmTarget(kind, params.target);
  const claimId = target ? confirmClaimId(kind, target) : null;
  const code = params.code.trim();
  if (!target || !claimId || !code) {
    return { status: 400, body: { error: "invalid confirm" } };
  }

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const challenge = params.challenge;
  if (
    !challenge ||
    challenge.address !== address ||
    challenge.kind !== kind ||
    challenge.targetHash !== hashConfirmBinding(address, kind, target) ||
    now < challenge.iat ||
    now >= challenge.exp
  ) {
    return { status: 400, body: { error: "invalid confirm" } };
  }

  const codeHash = hashConfirmBinding(address, kind, target, code);
  if (codeHash !== challenge.codeHash) {
    return { status: 400, body: { error: "invalid confirm" } };
  }

  return {
    status: 200,
    body: {
      kind,
      claimId,
      method: code === FIXTURE_CONFIRM_CODE ? "fixture" : "otp",
    },
  };
}

export async function signConfirmChallenge(
  challenge: ConfirmChallenge,
  secret: string,
): Promise<string> {
  return new SignJWT({
    address: challenge.address,
    kind: challenge.kind,
    targetHash: challenge.targetHash,
    codeHash: challenge.codeHash,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(challenge.iat)
    .setExpirationTime(challenge.exp)
    .sign(secretKey(secret));
}

export async function readConfirmChallenge(
  token: string,
  secret: string,
): Promise<ConfirmChallenge> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: ["HS256"],
  });
  if (typeof payload.address !== "string") {
    throw new Error("Confirm cookie is missing address.");
  }
  const kind = parseConfirmKind(payload.kind);
  if (!kind) {
    throw new Error("Confirm cookie is missing kind.");
  }
  if (
    typeof payload.targetHash !== "string" ||
    typeof payload.codeHash !== "string"
  ) {
    throw new Error("Confirm cookie is missing hashes.");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("Confirm cookie is missing iat/exp.");
  }
  return {
    address: getAddress(payload.address),
    kind,
    targetHash: payload.targetHash,
    codeHash: payload.codeHash,
    iat: payload.iat,
    exp: payload.exp,
  };
}
