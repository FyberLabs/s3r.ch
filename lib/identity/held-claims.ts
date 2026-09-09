/**
 * Held-claim ids linked from the user node.
 *
 * Claim object id is the claim id (e.g. `ens:vitalik.eth`).
 * Do not invent `s3rch/users/{wallet}/claims/…`.
 */

import { getAddress } from "viem";

export type HeldClaimOption = {
  id: string;
  label: string;
};

export const HELD_CLAIM_FAMILIES = [
  "ens",
  "unstoppable",
  "farcaster",
  "lens",
  "rss3",
  "email",
  "phone",
  "kyc",
] as const;

export type HeldClaimFamily = (typeof HELD_CLAIM_FAMILIES)[number];

export const HELD_CLAIM_PREFIX: Record<HeldClaimFamily, string> = {
  ens: "ens:",
  unstoppable: "unstoppable:",
  farcaster: "farcaster:",
  lens: "lens:",
  rss3: "rss3:",
  email: "email:",
  phone: "phone:",
  kyc: "kyc:",
};

/** `undefined` = lookup still in flight. `null` = settled empty. */
export type HeldLookupState = {
  [K in HeldClaimFamily]?: string | null;
};

export const SEE_GRANT_COPY =
  "Let another address see this. Revoke anytime.";

export function claimFamilyOf(claimId: string): HeldClaimFamily | null {
  const lower = claimId.trim().toLowerCase();
  for (const family of HELD_CLAIM_FAMILIES) {
    if (lower.startsWith(HELD_CLAIM_PREFIX[family])) return family;
  }
  return null;
}

export function claimLabelFromId(claimId: string): string {
  return claimId.replace(/^[a-z]+:/i, "");
}

export function ensClaimId(name: string): string {
  return `ens:${name.trim()}`;
}

export function unstoppableClaimId(name: string): string {
  return `unstoppable:${name.trim()}`;
}

export function farcasterClaimId(name: string): string {
  return `farcaster:${name.trim()}`;
}

export function lensClaimId(name: string): string {
  return `lens:${name.trim()}`;
}

export function rss3ClaimId(name: string): string {
  return `rss3:${name.trim()}`;
}

export function normalizeEmailTarget(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizePhoneTarget(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, "");
  const e164 = compact.startsWith("+") ? compact : `+${compact}`;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  return e164;
}

export function normalizeKycIssuer(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeKycSubject(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed)) return null;
  return trimmed;
}

export function parseKycLookup(
  value: string,
): { issuer: string; subject: string } | null {
  let rest = value.trim();
  if (!rest) return null;
  if (rest.toLowerCase().startsWith("kyc:")) rest = rest.slice(4);
  const cut = rest.indexOf(":");
  if (cut < 0) {
    const subject = normalizeKycSubject(rest);
    return subject ? { issuer: "fixture", subject } : null;
  }
  const issuer = normalizeKycIssuer(rest.slice(0, cut));
  const subject = normalizeKycSubject(rest.slice(cut + 1));
  if (!issuer || !subject) return null;
  return { issuer, subject };
}

export function emailClaimId(email: string): string {
  return `email:${normalizeEmailTarget(email) ?? email.trim().toLowerCase()}`;
}

export function phoneClaimId(phone: string): string {
  return `phone:${normalizePhoneTarget(phone) ?? phone.trim()}`;
}

export function kycClaimId(issuer: string, subject: string): string {
  const parsed = parseKycLookup(`${issuer}:${subject}`);
  if (!parsed) return `kyc:${issuer.trim().toLowerCase()}:${subject.trim().toLowerCase()}`;
  return `kyc:${parsed.issuer}:${parsed.subject}`;
}

export function lookupValueFromClaimId(claimId: string): string {
  const family = claimFamilyOf(claimId);
  if (family === "kyc") return claimId.replace(/^kyc:/i, "");
  return claimLabelFromId(claimId);
}

export function walletClaimId(address: string): string {
  return getAddress(address);
}

export function heldClaimOptions(input: {
  address: string;
  ens?: string | null;
  unstoppable?: string | null;
  farcaster?: string | null;
  lens?: string | null;
  rss3?: string | null;
  email?: string | null;
  phone?: string | null;
  kyc?: string | null;
}): HeldClaimOption[] {
  let checksum: string;
  try {
    checksum = getAddress(input.address);
  } catch {
    return [];
  }
  const options: HeldClaimOption[] = [
    { id: walletClaimId(checksum), label: checksum },
  ];
  if (input.ens) options.push({ id: ensClaimId(input.ens), label: input.ens });
  if (input.unstoppable) {
    options.push({
      id: unstoppableClaimId(input.unstoppable),
      label: input.unstoppable,
    });
  }
  if (input.farcaster) {
    options.push({
      id: farcasterClaimId(input.farcaster),
      label: input.farcaster,
    });
  }
  if (input.lens) options.push({ id: lensClaimId(input.lens), label: input.lens });
  if (input.rss3) options.push({ id: rss3ClaimId(input.rss3), label: input.rss3 });
  if (input.email && normalizeEmailTarget(input.email)) {
    options.push({
      id: emailClaimId(input.email),
      label: normalizeEmailTarget(input.email) ?? input.email,
    });
  }
  if (input.phone && normalizePhoneTarget(input.phone)) {
    options.push({
      id: phoneClaimId(input.phone),
      label: normalizePhoneTarget(input.phone) ?? input.phone,
    });
  }
  if (input.kyc) {
    const parsed = parseKycLookup(input.kyc);
    if (parsed) {
      options.push({
        id: kycClaimId(parsed.issuer, parsed.subject),
        label: `${parsed.issuer}:${parsed.subject}`,
      });
    }
  }
  return options;
}

/** Wallet plus already-linked overlay indicators. Source of truth is the Gun node. */
export function heldClaimOptionsFromIndicators(
  address: string,
  indicators: readonly string[],
): HeldClaimOption[] {
  let checksum: string;
  try {
    checksum = getAddress(address);
  } catch {
    return [];
  }
  const options: HeldClaimOption[] = [
    { id: walletClaimId(checksum), label: checksum },
  ];
  const seen = new Set<string>([checksum.toLowerCase()]);
  for (const raw of indicators) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ id, label: claimLabelFromId(id) });
  }
  return options;
}

export function parseGrantAccessor(value: string): string | null {
  try {
    return getAddress(value.trim());
  } catch {
    return null;
  }
}

export function grantWindowFromHours(
  hours: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): { from: number; until: number } | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const seconds = Math.floor(hours * 60 * 60);
  if (seconds <= 0) return null;
  return { from: nowSeconds, until: nowSeconds + seconds };
}
