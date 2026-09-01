import { SiweMessage } from "siwe";
import { getAddress, verifyMessage } from "viem";
import { ALLOWED_SIWE_HOSTS, SIWE_STATEMENT } from "./config";

export { SIWE_STATEMENT };

export type SiweVerifyInput = {
  message: string;
  signature: string;
  expectedNonce: string;
  requestHost: string;
  now?: Date;
};

export type SiweVerifyOk = {
  ok: true;
  address: string;
  chainId: number;
};

export type SiweVerifyErr = {
  ok: false;
  error: string;
};

export type SiweVerifyResult = SiweVerifyOk | SiweVerifyErr;

export function hostnameOf(domain: string): string {
  return domain.split(":")[0]?.toLowerCase() ?? "";
}

export function isAllowedSiweDomain(domain: string): boolean {
  return ALLOWED_SIWE_HOSTS.has(hostnameOf(domain));
}

export function parseSiweMessage(message: string): SiweMessage {
  return new SiweMessage(message);
}

export function buildSiweMessage(input: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt?: Date;
  expirationTime?: Date;
}): string {
  return new SiweMessage({
    domain: input.domain,
    address: getAddress(input.address),
    statement: SIWE_STATEMENT,
    uri: input.uri,
    version: "1",
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt: (input.issuedAt ?? new Date()).toISOString(),
    expirationTime: input.expirationTime?.toISOString(),
  }).prepareMessage();
}

/**
 * Parse + domain/nonce/expiry checks, then EOA verify via viem.
 * ERC-1271 is a follow-up (needs RPC).
 */
export async function verifySiweLogin(
  input: SiweVerifyInput,
): Promise<SiweVerifyResult> {
  let parsed: SiweMessage;
  try {
    parsed = parseSiweMessage(input.message);
  } catch {
    return { ok: false, error: "Invalid SIWE message." };
  }

  if (!isAllowedSiweDomain(parsed.domain)) {
    return { ok: false, error: "SIWE domain is not allowed." };
  }
  if (parsed.domain.toLowerCase() !== input.requestHost.toLowerCase()) {
    return { ok: false, error: "SIWE domain does not match this host." };
  }
  if (parsed.nonce !== input.expectedNonce) {
    return { ok: false, error: "SIWE nonce mismatch." };
  }
  if (parsed.version !== "1") {
    return { ok: false, error: "SIWE version must be 1." };
  }

  const now = input.now ?? new Date();
  if (parsed.expirationTime && now >= new Date(parsed.expirationTime)) {
    return { ok: false, error: "SIWE message expired." };
  }
  if (parsed.notBefore && now < new Date(parsed.notBefore)) {
    return { ok: false, error: "SIWE message is not yet valid." };
  }

  let address: `0x${string}`;
  try {
    address = getAddress(parsed.address);
  } catch {
    return { ok: false, error: "SIWE address is not valid." };
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address,
      message: input.message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, error: "SIWE signature is invalid." };
  }

  return { ok: true, address, chainId: parsed.chainId };
}
