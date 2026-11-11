import { parseAgentDelegation, parsePrincipalId, verifyAgentDelegation, type ResolutionContext } from "sociacl-ids";
import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { readForumSignature } from "../forum-sign";
import { isPublicSquadPrincipal } from "../squad-view";
import { isSeaPubkey } from "./forum-check";

/** Trusted service adapter, never a request body or unverified mesh response.
 * It must return complete current owner history and delegation revocations.
 * A missing/unavailable source denies; [] is allowed only for verified absence.
 */
export type AgentDelegationSource = (id: string, at: number) => Promise<Readonly<{
  completeThrough: number; delegation: unknown; rotations: readonly unknown[];
  context: Omit<ResolutionContext, "now">; revocations: readonly unknown[];
}> | null>;
const idPattern = /^[0-9a-f]{64}$/;
function agentScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
      !value.every((s, i) => typeof s === "string" && /^[a-z][a-z0-9:-]{0,63}$/.test(s) && (!i || value[i - 1] < s))) throw Error("Invalid agent scopes");
  return Object.freeze([...value]);
}

/** Server-side proof-of-possession sessions. consume must atomically record a
 * previously unused challenge ID until expiresAt, across all service instances.
 * Failure or unavailable storage must return false or throw, never grant reuse.
 * This proves key possession only; current principal/ACL checks remain mandatory.
 */
export function createIdentitySessions(input: {
  origin: string; secret: string;
  consume(id: string, expiresAt: number): Promise<boolean>;
  clock?: () => number;
  delegationSource?: AgentDelegationSource;
}) {
  if (typeof input.secret !== "string" || new TextEncoder().encode(input.secret).length < 32) throw Error("Explicit identity session configuration required");
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Canonical HTTPS origin required");
  const secret = new TextEncoder().encode(input.secret), issuer = origin.origin, audience = issuer;
  const consume = input.consume, clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const challengeType = "s3rch-identity-challenge-v1", sessionType = "s3rch-identity-session-v1";
  async function token(type: string, key: string, ttl: number, extra: Record<string, unknown> = {}, ceiling = Number.MAX_SAFE_INTEGER) {
    const now = clock(), expiresAt = Math.min(now + ttl, ceiling);
    if (!Number.isSafeInteger(now) || now < 0 || expiresAt <= now) throw Error("Invalid issuance time");
    return new SignJWT(extra).setSubject(key).setProtectedHeader({ alg: "HS256", typ: type })
      .setIssuer(issuer).setAudience(audience).setIssuedAt(now).setExpirationTime(expiresAt)
      .setJti(randomBytes(32).toString("hex")).sign(secret);
  }
  async function claims(value: string, type: string, ttl: number) {
    if (typeof value !== "string" || value.length > 4096) throw Error("Invalid session");
    const now = clock();
    const { payload } = await jwtVerify(value, secret, { algorithms: ["HS256"], typ: type,
      issuer, audience, currentDate: new Date(now * 1000), requiredClaims: ["iat", "exp", "jti"] });
    if (typeof payload.sub !== "string" || !isSeaPubkey(payload.sub) || isPublicSquadPrincipal(payload.sub) ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > now ||
        payload.exp! - payload.iat! !== ttl || typeof payload.jti !== "string" || !/^[0-9a-f]{64}$/.test(payload.jti)) throw Error("Invalid session");
    return { key: payload.sub, id: payload.jti, expiresAt: payload.exp! };
  }
  const agentChallengeType = "s3rch-agent-challenge-v1", agentSessionType = "s3rch-agent-session-v1";
  const delegationSource = input.delegationSource;
  async function delegation(id: string, scopes: readonly string[]) {
    if (typeof id !== "string" || !idPattern.test(id) || !delegationSource) throw Error("Delegation unavailable");
    const at = clock(), snapshot = await delegationSource(id, at);
    if (!snapshot || !Number.isSafeInteger(snapshot.completeThrough) || snapshot.completeThrough < at || clock() !== at) throw Error("Stale delegation source");
    const parsed = parseAgentDelegation(snapshot.delegation);
    if (!parsed.ok || parsed.value.id !== id || isPublicSquadPrincipal(parsed.value.delegation.principal) ||
        isPublicSquadPrincipal(parsed.value.delegation.agent)) throw Error("Invalid delegation");
    const result = verifyAgentDelegation(parsed.value.delegation, snapshot.rotations, { ...snapshot.context, now: at },
      { audience, agent: parsed.value.delegation.agent, scopes, revocations: snapshot.revocations });
    if (!result.ok || clock() !== at) throw Error("Invalid delegation authority");
    return result.value.delegation;
  }
  async function agentClaims(value: string, type: string, maximum: number) {
    if (typeof value !== "string" || value.length > 8192) throw Error("Invalid agent token");
    const now = clock();
    const { payload } = await jwtVerify(value, secret, { algorithms: ["HS256"], typ: type,
      issuer, audience, currentDate: new Date(now * 1000), requiredClaims: ["sub", "iat", "exp", "jti"] });
    if (!parsePrincipalId(payload.sub).ok || !parsePrincipalId(payload.agent).ok ||
        typeof payload.delegationId !== "string" || !idPattern.test(payload.delegationId) ||
        typeof payload.jti !== "string" || !idPattern.test(payload.jti) ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > now ||
        payload.exp! <= payload.iat! || payload.exp! - payload.iat! > maximum) throw Error("Invalid agent claims");
    return { principal: payload.sub!, agent: payload.agent as string, delegationId: payload.delegationId,
      scopes: agentScopes(payload.scopes), id: payload.jti, expiresAt: payload.exp! };
  }
  async function currentAgent(proof: Awaited<ReturnType<typeof agentClaims>>) {
    const record = await delegation(proof.delegationId, proof.scopes);
    if (record.principal !== proof.principal || record.agent !== proof.agent || proof.expiresAt > record.expiresAt) throw Error("Delegation mismatch");
    return record;
  }
  async function agentToken(type: string, id: string, scopes: readonly string[], maximum: number) {
    const record = await delegation(id, scopes);
    const ttl = Math.min(maximum, record.expiresAt - clock());
    if (ttl <= 0) throw Error("Expired delegation");
    return token(type, record.principal, ttl, { agent: record.agent, delegationId: id, scopes }, record.expiresAt);
  }
  return Object.freeze({
    /** Caller-selected scopes may only narrow the signed grant. This challenge
     * is signed by the agent, not the delegating owner. It grants no object ACL. */
    async agentChallenge(id: string, requestedScopes: readonly string[]): Promise<string | null> {
      try { return await agentToken(agentChallengeType, id, agentScopes(requestedScopes), 60); } catch { return null; }
    },
    async exchangeAgent(challenge: string, signature: string): Promise<string | null> {
      try {
        const proof = await agentClaims(challenge, agentChallengeType, 60);
        await currentAgent(proof);
        if (typeof signature !== "string" || signature.length > 32768 || await readForumSignature(signature, proof.agent) !== challenge) return null;
        await agentClaims(challenge, agentChallengeType, 60);
        if (!await consume(proof.id, proof.expiresAt)) return null;
        await agentClaims(challenge, agentChallengeType, 60);
        return await agentToken(agentSessionType, proof.delegationId, proof.scopes, 300);
      } catch { return null; }
    },
    async authenticateAgent(value: string, requiredScopes: readonly string[]) {
      try {
        const wanted = agentScopes(requiredScopes), proof = await agentClaims(value, agentSessionType, 300);
        if (!wanted.every(scope => proof.scopes.includes(scope))) return null;
        await currentAgent(proof);
        await agentClaims(value, agentSessionType, 300);
        return Object.freeze({ principal: proof.principal, agent: proof.agent, scopes: proof.scopes, delegationId: proof.delegationId });
      } catch { return null; }
    },
    async challenge(key: string) {
      if (!isSeaPubkey(key) || isPublicSquadPrincipal(key)) throw Error("Private SEA key required");
      // Sign this exact opaque string with signForumRecord(token, pair).
      return token(challengeType, key, 60);
    },
    async exchange(challenge: string, signature: string): Promise<string | null> {
      try {
        const proof = await claims(challenge, challengeType, 60);
        if (typeof signature !== "string" || signature.length > 16384 || await readForumSignature(signature, proof.key) !== challenge) return null;
        // Verification and storage can cross expiration; recheck both sides of consume.
        await claims(challenge, challengeType, 60);
        if (!await consume(proof.id, proof.expiresAt)) return null;
        await claims(challenge, challengeType, 60);
        return token(sessionType, proof.key, 300);
      } catch { return null; }
    },
    async authenticate(value: string): Promise<{ key: string } | null> {
      try { return { key: (await claims(value, sessionType, 300)).key }; } catch { return null; }
    },
  });
}
