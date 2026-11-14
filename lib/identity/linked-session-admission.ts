import { jwtVerify, type JWTVerifyGetKey } from "jose";
import type { KeyObject } from "node:crypto";
import { linkId, parseEip55, parseOidcCredential, resolveWalletLinkNow, resolveOidcLinkNow,
  type Eip55, type ResolutionContext } from "sociacl-ids";
import { verifyForumSiwe } from "./forum-siwe";
import { isSeaPubkey } from "./forum-check";
import { isPublicSquadPrincipal } from "../squad-view";

export type LinkedCredential = Readonly<{ kind: "wallet"; address: string }> |
  Readonly<{ kind: "oidc"; iss: string; tenant: string; sub: string }>;
export function parseLinkedCredential(value: unknown): LinkedCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.kind === "wallet" && Object.keys(row).sort().join() === "address,kind" && parseEip55(row.address).ok)
    return { kind: "wallet", address: row.address as string };
  if (row.kind === "oidc" && Object.keys(row).sort().join() === "iss,kind,sub,tenant") {
    const parsed = parseOidcCredential({ iss: row.iss, tenant: row.tenant, sub: row.sub });
    if (parsed.ok) return { kind: "oidc", ...parsed.value };
  }
  return null;
}

/** Trusted deployment adapter, never browser evidence or an owner-only export.
 * Must enumerate ALL candidate links for the credential, complete revocations,
 * and cryptographically authenticated histories through at. The history callback
 * is the owning resolver's successful current-key result, NOT caller assertions.
 * No production source satisfying this contract is currently configured.
 */
export type LinkedSessionSource = Readonly<{
  read(credential: LinkedCredential, at: number, signal: AbortSignal): Promise<Readonly<{
    completeThrough: number; links: readonly unknown[]; revocations: readonly unknown[];
    context: Omit<ResolutionContext, "now">;
  }> | null>;
}>;
export type LinkedOidcProvider = Readonly<{ issuer: string; clientId: string; tenant: string;
  tenantClaim: string; key: CryptoKey | KeyObject | JWTVerifyGetKey }>;
export type LinkedProofChallenge = Readonly<{ token: string; id: string; issuedAt: number; expiresAt: number }>;
export type LinkedSessionAdmission = ReturnType<typeof createLinkedSessionAdmission>;

/** Verification only. Session signing and challenge consumption remain in the
 * single identity issuer. No enrollment, key generation, rotation or writes. */
export function createLinkedSessionAdmission(input: { source: LinkedSessionSource | null;
  origin: string; walletChainIds: readonly string[]; oidc: readonly LinkedOidcProvider[] }) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Canonical HTTPS origin required");
  const providers = input.oidc.map(row => Object.freeze({ ...row }));
  const walletPolicy = { allowedDomains: [origin.host], allowedUris: [origin.origin + "/api/identity/sea/linked-exchange"],
    allowedChainIds: [...input.walletChainIds], clockSkewSeconds: 0 };
  const source = input.source;
  return Object.freeze({
    origin: origin.origin,
    async resolve(credential: LinkedCredential, at: number): Promise<Readonly<{ key: string; linkId: string }> | null> {
      if (!source || !parseLinkedCredential(credential) || !Number.isSafeInteger(at) || at < 0) return null;
      const signal = AbortSignal.timeout(5000);
      try {
        const snapshot = await Promise.race([source.read(credential, at, signal), new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(Error("Source unavailable")), { once: true }))]);
        if (!snapshot || snapshot.completeThrough !== at || !Array.isArray(snapshot.links) || snapshot.links.length > 128 ||
            !Array.isArray(snapshot.revocations) || snapshot.revocations.length > 1024) return null;
        const ctx = { ...snapshot.context, now: at };
        const resolution = credential.kind === "wallet"
          ? resolveWalletLinkNow(credential.address as Eip55, snapshot.links, snapshot.revocations, ctx)
          : resolveOidcLinkNow({ iss: credential.iss, tenant: credential.tenant, sub: credential.sub }, snapshot.links, snapshot.revocations, ctx);
        if (!resolution.ok) return null;
        // Upstream selects a newest link. Login must additionally refuse two
        // independently eligible identities, even when their timestamps differ.
        const principals = new Set<string>();
        for (const candidate of snapshot.links) {
          const eligible = credential.kind === "wallet"
            ? resolveWalletLinkNow(credential.address as Eip55, [candidate], snapshot.revocations, ctx)
            : resolveOidcLinkNow({ iss: credential.iss, tenant: credential.tenant, sub: credential.sub }, [candidate], snapshot.revocations, ctx);
          if (eligible.ok) principals.add(eligible.value.principal);
        }
        if (principals.size !== 1) return null;
        const state = ctx.history(resolution.value.principal, resolution.value.issuedAt, at);
        if (!state.ok || !isSeaPubkey(state.value.currentKey) || isPublicSquadPrincipal(state.value.currentKey)) return null;
        const id = linkId(resolution.value);
        return id.ok ? { key: state.value.currentKey, linkId: id.value } : null;
      } catch { return null; }
    },
    async verify(credential: LinkedCredential, proof: unknown, challenge: LinkedProofChallenge, now: number): Promise<boolean> {
      try {
        if (!proof || typeof proof !== "object" || Array.isArray(proof) || now < challenge.issuedAt || now >= challenge.expiresAt) return false;
        const row = proof as Record<string, unknown>;
        if (credential.kind === "wallet") {
          if (Object.keys(row).sort().join() !== "message,signature" || typeof row.message !== "string" || typeof row.signature !== "string") return false;
          return verifyForumSiwe(credential.address, row.message, row.signature, new TextEncoder().encode(challenge.token),
            challenge.issuedAt, now, walletPolicy, challenge.id);
        }
        if (Object.keys(row).join() !== "idToken" || typeof row.idToken !== "string" || row.idToken.length > 16384) return false;
        const matches = providers.filter(provider => provider.issuer === credential.iss && provider.tenant === credential.tenant);
        if (matches.length !== 1) return false;
        const provider = matches[0];
        if (!provider.clientId || !provider.tenantClaim) return false;
        const { payload } = await jwtVerify(row.idToken, provider.key as JWTVerifyGetKey, {
          algorithms: ["RS256", "PS256", "ES256"], issuer: provider.issuer, audience: provider.clientId,
          currentDate: new Date(now * 1000), requiredClaims: ["sub", "iat", "exp", "nonce", "auth_time"],
        });
        return (payload.aud === provider.clientId || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === provider.clientId)) &&
          payload.sub === credential.sub && payload[provider.tenantClaim] === credential.tenant && payload.nonce === challenge.id &&
          (payload.azp === undefined || payload.azp === provider.clientId) &&
          Number.isSafeInteger(payload.iat) && payload.iat! >= challenge.issuedAt && payload.iat! <= now &&
          Number.isSafeInteger(payload.exp) && payload.exp! > now &&
          Number.isSafeInteger(payload.auth_time) && (payload.auth_time as number) >= challenge.issuedAt && (payload.auth_time as number) <= now;
      } catch { return false; }
    },
  });
}
