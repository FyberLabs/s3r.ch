import { getAddress, verifyMessage, type Hex } from "viem";
import { buildMeshLinkStatement } from "./mesh-link";
import { seaToPrincipalKey } from "./forum-check";

/** Historical local wallet-link evidence, NOT current owner admission, global
 * account uniqueness, or a SociACL witness. Keep this file private. */
export async function exportOwnerLinkEvidence(input: unknown, address: string, origin: string): Promise<string> {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    const row = input as Record<string, unknown>;
    // Snapshot only the four public proof fields. Never serialize the record,
    // key pair, wrap envelope or any caller-supplied extra property.
    const wallet = row.address, principal = row.seaPub, message = row.signedPayload, signature = row.walletSignature;
    if (typeof wallet !== "string" || wallet !== getAddress(address) || getAddress(wallet) !== wallet ||
        typeof principal !== "string" || !seaToPrincipalKey(principal) ||
        typeof message !== "string" || message.length > 8192 ||
        typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error();
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || url.protocol !== "https:") throw new Error();
    const expected = buildMeshLinkStatement({domain: url.host, uri: origin, address: wallet, seaPub: principal});
    if (message !== expected || !await verifyMessage({address: getAddress(wallet), message, signature: signature as Hex})) throw new Error();
    return JSON.stringify({version: 1, kind: "s3rch-local-wallet-link-evidence", origin,
      wallet, sea_public_key: principal, message, signature}, null, 2) + "\n";
  } catch {
    throw new Error("Existing wallet link could not be verified.");
  }
}
