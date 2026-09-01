import { SiweMessage } from "siwe";
import {
  createPublicClient,
  getAddress,
  http,
  verifyMessage as verifyEoaMessage,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import { ALLOWED_SIWE_HOSTS, SIWE_STATEMENT } from "./config";

export { SIWE_STATEMENT };

/** Mainnet only for contract (ERC-1271 / EIP-6492) verify. */
export const SIWE_CONTRACT_VERIFY_CHAIN_ID = 1;

/** Local Anvil / Hardhat — EOA ecrecover only. Never forwarded to mainnet. */
export const LOCAL_EOA_ONLY_CHAIN_IDS = new Set([31337, 1337]);

export type SiweVerifyInput = {
  message: string;
  signature: string;
  expectedNonce: string;
  requestHost: string;
  now?: Date;
  /**
   * Injected in tests so ERC-1271 does not hit live RPC.
   * Production leaves this unset and uses {@link defaultSiweVerifyClient}.
   * Pass `null` to force EOA-only (no contract fallback).
   */
  verifyClient?: SiweSignatureVerifier | null;
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

/**
 * Narrow viem surface so tests can mock without a live RPC.
 * Production uses {@link createMainnetSiweVerifyClient}.
 *
 * viem's `publicClient.verifyMessage` is ERC-1271 + EIP-6492 (and EOA fallback).
 */
export type SiweSignatureVerifier = {
  verifyMessage: (args: {
    address: Address;
    message: string;
    signature: Hex;
  }) => Promise<boolean>;
};

export function hostnameOf(domain: string): string {
  return domain.split(":")[0]?.toLowerCase() ?? "";
}

export function isAllowedSiweDomain(domain: string): boolean {
  return ALLOWED_SIWE_HOSTS.has(hostnameOf(domain));
}

export function parseSiweMessage(message: string): SiweMessage {
  return new SiweMessage(message);
}

export function canVerifySiweContractOnChain(chainId: number): boolean {
  return chainId === SIWE_CONTRACT_VERIFY_CHAIN_ID;
}

/**
 * Mainnet public client, same `http()` transport as `lib/identity/ens.ts`
 * and `lib/identity/wagmi.ts`. No Azure / Alchemy / Infura secret. viem's
 * default mainnet public endpoint is enough for this lab slice; pin a public
 * HTTP URL later if it flakes.
 *
 * `verifyMessage` here is ERC-1271 for deployed smart accounts and EIP-6492
 * for counterfactual / undeployed wrappers. Do not invent a second verify path.
 */
export function createMainnetSiweVerifyClient(): SiweSignatureVerifier {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(),
  });
  return {
    verifyMessage: (args) => client.verifyMessage(args),
  };
}

/**
 * Pick a contract-verify client from the SIWE `chainId`.
 * Mainnet → public HTTP client. Anvil / localhost / anything else → `null`
 * (EOA ecrecover only). Never send a local chain's contract call to mainnet.
 */
export function defaultSiweVerifyClient(
  chainId: number,
): SiweSignatureVerifier | null {
  if (!canVerifySiweContractOnChain(chainId)) return null;
  return createMainnetSiweVerifyClient();
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
 * Parse + domain/nonce/expiry checks, then signature verify.
 *
 * 1. Local EOA `ecrecover` (no RPC). Anvil / local keys stay here.
 * 2. If that fails and the SIWE chain can do contract verify, call
 *    viem `publicClient.verifyMessage` (ERC-1271 magic + EIP-6492).
 *
 * Session subject is the checksummed message address (contract or EOA).
 * RPC / bad-magic failures are a quiet invalid signature — never a 500 dump.
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

  let address: Address;
  try {
    address = getAddress(parsed.address);
  } catch {
    return { ok: false, error: "SIWE address is not valid." };
  }

  const signature = input.signature as Hex;

  let valid = false;
  try {
    valid = await verifyEoaMessage({
      address,
      message: input.message,
      signature,
    });
  } catch {
    valid = false;
  }
  if (valid) {
    return { ok: true, address, chainId: parsed.chainId };
  }

  const client =
    input.verifyClient !== undefined
      ? input.verifyClient
      : defaultSiweVerifyClient(parsed.chainId);

  if (!client) {
    return { ok: false, error: "SIWE signature is invalid." };
  }

  try {
    valid = await client.verifyMessage({
      address,
      message: input.message,
      signature,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, error: "SIWE signature is invalid." };
  }

  return { ok: true, address, chainId: parsed.chainId };
}
