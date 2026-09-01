/**
 * WebAuthn PRF wrap — stub only. No UI in this slice.
 *
 * Later recovery (not implemented):
 * - rp.id = s3r.ch
 * - WebAuthn PRF extension derives a KEK
 * - A DEK is wrapped by that PRF KEK and by a second KEK
 * - Store the envelope in IndexedDB (replaces today's plaintext seaPair)
 * - Never write the envelope, DEK, or KEKs to a public Gun node
 * - No SimpleWebAuthn dependency yet
 */

export type WrapKekKind = "prf" | "secondary";

export type PrfWrapEnvelope = {
  version: 1;
  rpId: "s3r.ch";
  dekWrappedByPrfKek: string;
  dekWrappedBySecondaryKek: string;
};

export function notImplemented(
  feature = "WebAuthn PRF wrap",
): never {
  throw new Error(`${feature} is not implemented in this identity slice.`);
}

export function wrapDek(_params: {
  dek: Uint8Array;
  prfKek: Uint8Array;
  secondaryKek: Uint8Array;
}): PrfWrapEnvelope {
  return notImplemented();
}

export function unwrapDek(_envelope: PrfWrapEnvelope): Uint8Array {
  return notImplemented();
}
