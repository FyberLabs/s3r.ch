import { getAddress, verifyMessage, type Hex } from "viem";
import { seaToPrincipalKey } from "./forum-check";
import { verifyForumKeySignature } from "./forum-key-signature";

export type OperatorBinding = Readonly<{
  version: 1; domain: string; purpose: "s3rch-operator-binding/v1";
  wallet: string; sea_public_key: string; timestamp: number;
  wallet_signature: string; sea_signature: string;
}>;
export type DeclaredOperator = Readonly<{domain: string; wallet: string; sea_public_key: string}>;
const fields = ["version", "domain", "purpose", "wallet", "sea_public_key", "timestamp", "wallet_signature", "sea_signature"].sort();
const purpose = "s3rch-operator-binding/v1";
function validDeclaration(row: DeclaredOperator): boolean {
  const url = new URL(`https://${row.domain}`);
  return url.host === row.domain && url.origin === `https://${row.domain}` &&
    !url.username && !url.password && getAddress(row.wallet) === row.wallet && !!seaToPrincipalKey(row.sea_public_key);
}

/** Exact UTF-8 bytes signed with EIP-191 (wallet) or SociACL compact P-256
 * SHA-256 r||s (existing SEA signing key). No Gun envelope or JSON reserialization.
 * Timestamp is a durable binding event, not a short-lived login challenge. */
export function operatorBindingStatement(row: Pick<OperatorBinding, "domain" | "wallet" | "sea_public_key" | "timestamp">,
  role: "wallet-to-sea" | "sea-to-wallet"): string {
  if (!validDeclaration(row) || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0 ||
      (role !== "wallet-to-sea" && role !== "sea-to-wallet")) throw Error("Invalid operator binding statement");
  return [purpose, `role=${role}`, `domain=${row.domain}`, `wallet=${row.wallet}`,
    `sea_public_key=${row.sea_public_key}`, `timestamp=${row.timestamp}`].join("\n");
}

/** Verify a bounded public declaration set against independently configured
 * operator identity. No key access, network, signing, enrollment or fallback.
 * A second row for the wallet refuses, even if one proof is otherwise valid. */
export async function verifyOperatorBinding(input: unknown, declared: DeclaredOperator): Promise<OperatorBinding | null> {
  try {
    const expected = {...declared};
    if (!validDeclaration(expected) || !Array.isArray(input) || input.length < 1 || input.length > 64) return null;
    const rows = structuredClone(input) as Record<string, unknown>[];
    if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== fields.join(",") || typeof row.wallet !== "string")) return null;
    // Normalize addresses only to detect conflicting declarations; the selected
    // record itself must carry the canonical checksummed address.
    const candidates = rows.filter(row => getAddress(row.wallet as string) === expected.wallet);
    if (candidates.length !== 1) return null;
    const row = candidates[0];
    if (row.version !== 1 || row.purpose !== purpose || row.domain !== expected.domain ||
        row.wallet !== expected.wallet || row.sea_public_key !== expected.sea_public_key ||
        typeof row.timestamp !== "number" || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0 ||
        typeof row.wallet_signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(row.wallet_signature) ||
        typeof row.sea_signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(row.sea_signature)) return null;
    const binding = row as unknown as OperatorBinding;
    if (!await verifyMessage({address: getAddress(binding.wallet),
      message: operatorBindingStatement(binding, "wallet-to-sea"), signature: binding.wallet_signature as Hex})) return null;
    if (!verifyForumKeySignature(binding.sea_public_key, binding.sea_signature,
      new TextEncoder().encode(operatorBindingStatement(binding, "sea-to-wallet")))) return null;
    return Object.freeze({...binding});
  } catch { return null; }
}
