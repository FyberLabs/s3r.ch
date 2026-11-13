// Trusted HTTP/history/cryptographic contracts: run only in CI.
import assert from "node:assert/strict";
import { importJWK, SignJWT } from "jose";
import { p256 } from "@noble/curves/nist.js";
import { agentDelegationBytes, agentRevocationBytes, parseAgentDelegation, parsePrincipalId, parseTenantId, signingBytes, signWithKeyring } from "sociacl-ids";
import { createAclDelegationSource, type DelegationTrust } from "../acl-delegation-source-server";
import { createIdentitySessions } from "../sea-session";
export const f = { now: 1700000000 };
const config = { origin: "https://acl.example", tenant: "01234567-89ab-cdef-0123-456789abcdef", scope: "agents", apiKey: "private-test-key" };
const audience = "https://s3r.ch";
const principal = (value: string) => { const result = parsePrincipalId(value); assert.ok(result.ok); return result.value; };
export async function setup() {
  const key = new Uint8Array(32); key[31] = 103;
  const agentKey = new Uint8Array(32); agentKey[31] = 109;
  const point = p256.getPublicKey(agentKey, false);
  const agent = principal(Buffer.from(point.slice(1,33)).toString("base64url") + "." + Buffer.from(point.slice(33)).toString("base64url"));
  const ownerPoint = p256.getPublicKey(key, false);
  const owner = principal(Buffer.from(ownerPoint.slice(1,33)).toString("base64url") + "." + Buffer.from(ownerPoint.slice(33)).toString("base64url"));
  const sign = (bytes: Uint8Array) => { const r = signWithKeyring(key, bytes, owner); assert.ok(r.ok); return r.value; };
  const epubKey = new Uint8Array(32); epubKey[31] = 107;
  const epubPoint = p256.getPublicKey(epubKey, false);
  const epub = principal(Buffer.from(epubPoint.slice(1,33)).toString("base64url") + "." + Buffer.from(epubPoint.slice(33)).toString("base64url"));
  const witness = new Uint8Array(32); witness[31] = 101;
  const witnessPoint = p256.getPublicKey(witness, false);
  const jwk = { kty: "EC" as const, crv: "P-256" as const, kid: "ci-agent-witness",
    x: Buffer.from(witnessPoint.slice(1,33)).toString("base64url"), y: Buffer.from(witnessPoint.slice(33)).toString("base64url"),
    notBefore: f.now-1000, notAfter: f.now+1000 };
  const genesis = { v: 1 as const, kind: "genesis-epub" as const, principal: owner, epub, issuedAt: f.now };
  const bytes = signingBytes(genesis); assert.ok(bytes.ok);
  const attest = await new SignJWT({typ:"sociacl-genesis-epub-attest-v1",principal:owner,epub})
    .setProtectedHeader({alg:"ES256",kid:jwk.kid}).setIssuedAt(f.now).setExpirationTime(f.now+60)
    .sign(await importJWK({...jwk,d:Buffer.from(witness).toString("base64url")},"ES256"));
  const binding = {...genesis,keySig:sign(bytes.value),attest};
  const tenant=parseTenantId(config.tenant); assert.ok(tenant.ok);
  const cred = {iss:"https://identity.example",tenant:tenant.value,sub:"ci-owner"};
  const link = {v:1 as const,kind:"oidc" as const,principal:owner,cred,nonce:"a".repeat(16),issuedAt:f.now};
  const linkBytes=signingBytes(link); assert.ok(linkBytes.ok);
  const linkAttest=await new SignJWT({typ:"sociacl-oidc-attest-v1",...cred,principal:owner,nonce:link.nonce})
    .setProtectedHeader({alg:"ES256",kid:jwk.kid}).setIssuedAt(f.now).setExpirationTime(f.now+60)
    .sign(await importJWK({...jwk,d:Buffer.from(witness).toString("base64url")},"ES256"));
  const oidc={...link,keySig:sign(linkBytes.value),attest:linkAttest};
  const unsigned = { v: 1 as const, principal: owner, agent, audience, scopes: ["forum:read"], nonce: "a".repeat(64), issuedAt: f.now, expiresAt: f.now+60 };
  const delegation = { ...unsigned, sig: sign(agentDelegationBytes(unsigned)) };
  const parsed = parseAgentDelegation(delegation); assert.ok(parsed.ok); const id = parsed.value.id;
  const cancel = { v: 1 as const, principal: owner, delegationId: id, issuedAt: f.now };
  const revocation = { ...cancel, sig: sign(agentRevocationBytes(cancel)) };
  const document = { fence: "a".repeat(64), snapshot: { audience, completeThrough: f.now,
    history: { completeThrough: f.now, links: [] as unknown[], accounts: [{ principal: owner, rotations: [] as unknown[], revocations: [] as unknown[], genesisEpubBindings: [binding] }] },
    rows: [{ kind: "delegation", record: delegation }] as { kind: string; record: unknown }[] } };
  let now = f.now, status = 200, calls = 0;
  const trust = structuredClone({ jwks: {keys:[jwk]}, policy: {allowedDomains:[],allowedUris:[],allowedChainIds:[]}, pinnedIss: new Set<string>([cred.iss]) }) as DelegationTrust;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://acl.example/api/v1/acl/sociacl/delegations/agents/snapshot");
    assert.equal(new Headers(options?.headers).get("X-Tenant-ID"), config.tenant);
    assert.equal(options?.redirect, "error");
    return Response.json(document, { status });
  };
  const source = createAclDelegationSource(config, audience, trust, fetcher, () => now);
  const sessions = createIdentitySessions({ origin: audience, secret: "x".repeat(32), consume: async () => true, clock: () => now, delegationSource: source });
  return { document, source, sessions, id, revocation, trust, oidc, sourceConfig:config,
    agentPair:{pub:agent,priv:Buffer.from(agentKey).toString("base64url"),epub:agent,epriv:Buffer.from(agentKey).toString("base64url")}, calls: () => calls,
    offline: () => { status=503; }, advance: () => { now++; } };
}
