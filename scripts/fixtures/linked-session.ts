/** Isolated unit/nightly fixture. Synthetic signing keys and complete single-account
 * source substitute for unavailable hosted authority; never deployed. */
import { p256 } from "@noble/curves/nist.js";
import { privateKeyToAccount } from "viem/accounts";
import { decodeJwt, importJWK, SignJWT } from "jose";
import { historyState, parsePrincipalId, type ResolutionContext } from "sociacl-ids";
import { recoveryId, parseForumRecoveryRecord } from "../../lib/identity/forum-recovery-records";
import { parseForumWalletLinkRecord } from "../../lib/identity/forum-wallet-link-record";
import { parseForumRevoke } from "../../lib/identity/forum-revocation";
import { createLinkedSessionAdmission, type LinkedCredential, type LinkedSessionSource } from "../../lib/identity/linked-session-admission";
import { createIdentitySessions } from "../../lib/identity/sea-session";
const origin = "https://s3r.ch", issuer = "https://id.example/realms/site", tenant = "01234567-89ab-cdef-0123-456789abcdef";
const b64 = (v: string | Uint8Array) => Buffer.from(v).toString("base64url");
const scalar = (n: number) => { const bytes = new Uint8Array(32); bytes[31] = n; return bytes; };
const pub = (n: number) => { const p = p256.getPublicKey(scalar(n), false); return b64(p.slice(1, 33)) + "." + b64(p.slice(33)); };
const sign = (bytes: Uint8Array, n: number) => b64(p256.sign(bytes, scalar(n), { prehash: true, format: "compact" }));
const [x, y] = pub(7).split(".");
const witness = (claims: Record<string, unknown>) => {
  const input = b64(JSON.stringify({ alg: "ES256", kid: "unit" })) + "." + b64(JSON.stringify(claims));
  return input + "." + sign(new TextEncoder().encode(input), 7);
};
const wallet = privateKeyToAccount(("0x" + "0".repeat(63) + "4") as `0x${string}`);
async function siwe(bytes: Uint8Array, at: number, nonce: string, uri = origin + "/identity/link") {
  const message = `s3r.ch wants you to sign in with your Ethereum account:\n${wallet.address}\n\nSociACL link: ${await recoveryId(bytes)}\n\nURI: ${uri}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date(at * 1000).toISOString().replace('.000Z', 'Z')}`;
  return { message, signature: await wallet.signMessage({ message }) };
}
export async function linkedSessionFixture(kind: "wallet" | "oidc") {
  const at = 100, principal = pub(101);
  const credential: LinkedCredential = kind === "wallet" ? { kind, address: wallet.address } : { kind, iss: issuer, tenant, sub: "person" };
  let link: Record<string, unknown> = { v: 1, kind, principal, issuedAt: at, nonce: "unitNonce123", keySig: "pending", attest: "pending" };
  if (kind === "wallet") link = { ...link, address: wallet.address, siwe: { message: "", signature: "0x" + "00".repeat(65) } };
  else link.cred = { iss: issuer, tenant, sub: "person" };
  const bytes = kind === "wallet" ? parseForumWalletLinkRecord(link)!.bytes : parseForumRecoveryRecord(link)!.bytes;
  const id = await recoveryId(bytes);
  link.keySig = sign(bytes, 101);
  if (kind === "wallet") link.siwe = await siwe(bytes, at, "unitNonce123");
  link.attest = witness({ typ: kind === "wallet" ? "sociacl-wallet-attest-v1" : "sociacl-oidc-attest-v1", principal,
    ...(kind === "wallet" ? { linkId: id } : { iss: issuer, tenant, sub: "person", nonce: "unitNonce123" }), iat: at, exp: 900 });
  let now = 200, available = true, stale = false, missingHistory = false, rotated = false;
  let links: unknown[] = [link], revocations: unknown[] = [];
  const key = await importJWK({ kty: "EC", crv: "P-256", x, y, d: b64(scalar(7)) }, "ES256");
  const verificationKey = await importJWK({ kty: "EC", crv: "P-256", x, y }, "ES256");
  const context: Omit<ResolutionContext, "now"> = {
    jwks: { keys: [{ kty: "EC", crv: "P-256", kid: "unit", x, y, notBefore: 0, notAfter: 10000 }] },
    links: new Map([[id, link]]), policy: { allowedDomains: ["s3r.ch"], allowedUris: [origin + "/identity/link"], allowedChainIds: ["1"] },
    pinnedIss: new Set([issuer]),
    // Unit-only unrotated authority. Hosted code has no equivalent configured source.
    history(owner, at, until) {
      const parsed = parsePrincipalId(owner), next = parsePrincipalId(pub(102));
      return !missingHistory && [principal, pub(102)].includes(owner) && parsed.ok && next.ok
        ? { ok: true, value: rotated && owner === principal ? { key: parsed.value, currentKey: next.value, retainedLinks: [id] } : historyState(parsed.value, [], at, until) } : { ok: false, reason: "missing-history" };
    },
  };
  const source: LinkedSessionSource = { async read(_, at) { return available ? { completeThrough: at - (stale ? 1 : 0), links, revocations, context } : null; } };
  const admission = createLinkedSessionAdmission({ source, origin, walletChainIds: ["1"],
    oidc: [{ issuer, tenant, clientId: "site", tenantClaim: "tenant_id", key: verificationKey }] });
  const used = new Set<string>();
  let afterConsume = () => {};
  const options = { origin, secret: "unit-only-issuer-secret".repeat(3), clock: () => now, linkedAdmission: admission,
    consume: async (id: string) => { if (used.has(id)) return false; used.add(id); afterConsume(); return true; } };
  const sessions = createIdentitySessions(options);
  async function proof(challenge: string, overrides: Record<string, unknown> = {}) {
    const c = decodeJwt(challenge);
    if (kind === "wallet") return siwe(new TextEncoder().encode(challenge), c.iat!, c.jti!, origin + "/api/identity/sea/linked-exchange");
    return { idToken: await new SignJWT({ tenant_id: tenant, nonce: c.jti, auth_time: now, ...overrides }).setSubject("person")
      .setIssuer(issuer).setAudience("site").setIssuedAt(now).setExpirationTime(now + 60).setProtectedHeader({ alg: "ES256" }).sign(key) };
  }
  function revoke() {
    const row = { v: 1 as const, kind: "revoke" as const, principal, linkId: id, issuedAt: now, keySig: "pending" };
    row.keySig = sign(parseForumRevoke(row)!.bytes, 101); revocations = [row];
  }
  async function conflict() {
    const other = { ...link, principal: pub(102), issuedAt: 101, nonce: "otherNonce123", keySig: "pending", attest: "pending" };
    const bytes = kind === "wallet" ? parseForumWalletLinkRecord(other)!.bytes : parseForumRecoveryRecord(other)!.bytes;
    const otherId = await recoveryId(bytes); other.keySig = sign(bytes, 102);
    if (kind === "wallet") (other as Record<string, unknown>).siwe = await siwe(bytes, 101, "otherNonce123");
    other.attest = witness({ typ: kind === "wallet" ? "sociacl-wallet-attest-v1" : "sociacl-oidc-attest-v1", principal: other.principal,
      ...(kind === "wallet" ? { linkId: otherId } : { iss: issuer, tenant, sub: "person", nonce: "otherNonce123" }), iat: 101, exp: 900 });
    links = [link, other];
  }
  return { conflict, rotate: () => { rotated = true; }, credential, principal, sessions, options, proof, revoke, source, used, admission,
    advance: () => { now += 60; }, unavailable: () => { available = false; }, stale: () => { stale = true; },
    missing: () => { links = []; }, badHistory: () => { missingHistory = true; }, tamper: () => { links = [{ ...link, keySig: "invalid" }]; },
    onConsume: (fn: () => void) => { afterConsume = fn; } };
}
