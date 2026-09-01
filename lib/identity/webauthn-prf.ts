/**
 * Native WebAuthn Level 3 PRF helper.
 *
 * `extensions.prf` only — not credBlob / largeBlob. No SimpleWebAuthn.
 * rp.id is per-origin (`s3r.ch` in production, `localhost` / `127.0.0.1` locally).
 * Do not use a parent domain that would break `__Host-` cookies.
 *
 * Lab-real targets: Chrome + Google Password Manager PRF, Safari iCloud
 * (macOS 15+ / iOS 18.4+). If PRF is missing, throw — never fake a wrap.
 */

import { getAddress, hexToBytes } from "viem";
import { resolveRpId, type SeaWrapRpId } from "./wrap";

export const PRF_UNAVAILABLE_MESSAGE =
  "Passkey PRF is not available in this browser. Use Chrome with Google Password Manager, or Safari on macOS 15+ / iOS 18.4+. The mesh key was not wrapped.";

export class PrfUnavailableError extends Error {
  readonly code = "PRF_UNAVAILABLE";

  constructor(message = PRF_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "PrfUnavailableError";
  }
}

type PrfEval = { eval: { first: BufferSource } };

type PrfExtensionResults = {
  enabled?: boolean;
  results?: { first?: ArrayBuffer | Uint8Array };
};

export type PrfAvailability =
  | { available: true }
  | { available: false; reason: string };

export type CreatePrfCredentialInput = {
  address: string;
  rpId?: SeaWrapRpId;
  host?: string;
  prfSalt?: Uint8Array;
  credentials?: CredentialsContainer;
};

export type CreatePrfCredentialResult = {
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  prfOutput: Uint8Array;
  rpId: SeaWrapRpId;
};

export type EvaluatePrfInput = {
  rpId: SeaWrapRpId;
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  credentials?: CredentialsContainer;
};

export async function detectPrfAvailability(
  publicKeyCredential: typeof PublicKeyCredential | undefined = globalThis.PublicKeyCredential,
): Promise<PrfAvailability> {
  if (!publicKeyCredential) {
    return { available: false, reason: PRF_UNAVAILABLE_MESSAGE };
  }
  const getCaps = (
    publicKeyCredential as typeof PublicKeyCredential & {
      getClientCapabilities?: () => Promise<Record<string, unknown>>;
    }
  ).getClientCapabilities;
  if (typeof getCaps === "function") {
    try {
      const caps = await getCaps.call(publicKeyCredential);
      if (caps["extension:prf"] === false || caps.prf === false) {
        return { available: false, reason: PRF_UNAVAILABLE_MESSAGE };
      }
    } catch {
      // Capabilities probe failed — allow an attempt; create/get still refuse to fake.
    }
  }
  return { available: true };
}

export function readPrfFromExtensionResults(results: unknown): Uint8Array {
  if (!results || typeof results !== "object") {
    throw new PrfUnavailableError();
  }
  const prf = (results as { prf?: PrfExtensionResults }).prf;
  const first = prf?.results?.first;
  if (!first) {
    throw new PrfUnavailableError(
      prf?.enabled === false
        ? PRF_UNAVAILABLE_MESSAGE
        : "Passkey was created but PRF results were missing. The mesh key was not wrapped.",
    );
  }
  const bytes = first instanceof Uint8Array ? first : new Uint8Array(first);
  if (bytes.byteLength < 16) {
    throw new PrfUnavailableError();
  }
  return Uint8Array.from(bytes);
}

export async function createPrfCredential(
  input: CreatePrfCredentialInput,
): Promise<CreatePrfCredentialResult> {
  const credentials = input.credentials ?? globalThis.navigator?.credentials;
  if (!credentials?.create || !credentials.get) {
    throw new PrfUnavailableError();
  }
  const rpId = input.rpId ?? resolveRpId(input.host ?? globalThis.location?.host ?? "");
  const address = getAddress(input.address);
  const prfSalt = input.prfSalt
    ? Uint8Array.from(input.prfSalt)
    : crypto.getRandomValues(new Uint8Array(32));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = hexToBytes(address);

  const publicKey = {
    rp: { id: rpId, name: "s3r.ch" },
    user: {
      id: copyBuffer(userId),
      name: address,
      displayName: `s3r.ch mesh wrap ${address.slice(0, 6)}…${address.slice(-4)}`,
    },
    challenge: copyBuffer(challenge),
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    timeout: 60_000,
    attestation: "none",
    extensions: {
      prf: { eval: { first: copyBuffer(prfSalt) } } satisfies PrfEval,
    },
  } as PublicKeyCredentialCreationOptions;

  let created: Credential | null;
  try {
    created = await credentials.create({ publicKey });
  } catch (error) {
    throw toPrfError(error);
  }
  if (!created || !("rawId" in created) || !created.rawId) {
    throw new PrfUnavailableError();
  }
  const credential = created as PublicKeyCredential;

  const credentialId = new Uint8Array(credential.rawId);
  let prfOutput: Uint8Array;
  try {
    prfOutput = readPrfFromExtensionResults(credential.getClientExtensionResults());
  } catch {
    prfOutput = await evaluatePrf({
      rpId,
      credentialId,
      prfSalt,
      credentials,
    });
  }

  return { credentialId, prfSalt, prfOutput, rpId };
}

export async function evaluatePrf(input: EvaluatePrfInput): Promise<Uint8Array> {
  const credentials = input.credentials ?? globalThis.navigator?.credentials;
  if (!credentials?.get) {
    throw new PrfUnavailableError();
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = {
    rpId: input.rpId,
    challenge: copyBuffer(challenge),
    allowCredentials: [{ type: "public-key", id: copyBuffer(input.credentialId) }],
    userVerification: "required",
    timeout: 60_000,
    extensions: {
      prf: { eval: { first: copyBuffer(input.prfSalt) } } satisfies PrfEval,
    },
  } as PublicKeyCredentialRequestOptions;

  let assertion: Credential | null;
  try {
    assertion = await credentials.get({ publicKey });
  } catch (error) {
    throw toPrfError(error);
  }
  if (!assertion || !("getClientExtensionResults" in assertion)) {
    throw new PrfUnavailableError();
  }
  return readPrfFromExtensionResults(
    (assertion as PublicKeyCredential).getClientExtensionResults(),
  );
}

function copyBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function toPrfError(error: unknown): PrfUnavailableError {
  if (error instanceof PrfUnavailableError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/not allowed|not supported|unknown extension|prf/i.test(message)) {
    return new PrfUnavailableError();
  }
  return new PrfUnavailableError(
    error instanceof Error ? error.message : PRF_UNAVAILABLE_MESSAGE,
  );
}
