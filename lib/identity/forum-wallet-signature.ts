import { getAddress, recoverMessageAddress, type Hex } from "viem";

/** EIP-191 EOA signature validity only, matching SociACL b7f9bc59 siweVerify's
 * cryptographic step. No RPC/contract-wallet fallback or authority admission.
 * Callers must separately validate SIWE policy, record binding, time, nonce,
 * and the wallet's authenticated recovery-link eligibility.
 */
export async function verifyForumWalletSignature(
  address: unknown, message: unknown, signature: unknown,
): Promise<boolean> {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    typeof message !== "string" || message.length > 8192 ||
    typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const recovery = Number.parseInt(signature.slice(-2), 16);
  if (![0, 1, 27, 28].includes(recovery)) return false;
  try {
    // Require the canonical EIP-55 spelling, not a case-insensitive match.
    if (getAddress(address) !== address) return false;
    return await recoverMessageAddress({ message, signature: signature as Hex }) === address;
  } catch { return false; }
}
