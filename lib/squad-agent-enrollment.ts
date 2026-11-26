import { agentDelegationBytes, agentRevocationBytes, parsePrincipalId, signWithKeyring } from "sociacl-ids";
import type { SeaPair } from "./identity/sea";

export const SQUAD_AGENT_SCOPE = "forum:read";
export const SQUAD_AGENT_GRANT_SECONDS = 86_400;

export type SquadAgentGrant = {
  id: string;
  agent: string;
  expiresAt: number;
  status: "active" | "expired" | "revoked";
};

export type SquadAgentEnrollment = {
  owner: string;
  evaluatedAt: number;
  agents: string[];
  grants: SquadAgentGrant[];
};

function signature(pair: SeaPair, bytes: Uint8Array) {
  const key = parsePrincipalId(pair.pub);
  if (!key.ok || !/^[A-Za-z0-9_-]{43}$/.test(pair.priv)) throw Error("Unlock the Squad owner identity");
  const scalar = Uint8Array.from(atob(pair.priv.replace(/-/g, "+").replace(/_/g, "/") + "="), value => value.charCodeAt(0));
  try {
    const signed = signWithKeyring(scalar, bytes, key.value);
    if (!signed.ok) throw Error("Could not sign Squad enrollment");
    return signed.value;
  } finally { scalar.fill(0); }
}

export function approveSquadAgent(pair: SeaPair, state: SquadAgentEnrollment, origin: string, agentKey: string) {
  const principal = parsePrincipalId(state.owner), agent = parsePrincipalId(agentKey);
  if (!principal.ok || !agent.ok || !state.agents.includes(agent.value)) throw Error("Choose a Squad agent");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const record = { v: 1 as const, principal: principal.value, agent: agent.value, audience: origin,
    scopes: [SQUAD_AGENT_SCOPE], nonce, issuedAt: state.evaluatedAt, expiresAt: state.evaluatedAt + SQUAD_AGENT_GRANT_SECONDS };
  return { ...record, sig: signature(pair, agentDelegationBytes(record)) };
}

export function revokeSquadAgent(pair: SeaPair, state: SquadAgentEnrollment, delegationId: string) {
  const owner = parsePrincipalId(state.owner);
  if (!owner.ok || !state.grants.some(grant => grant.id === delegationId && grant.status === "active"))
    throw Error("Choose an active Squad enrollment");
  const record = { v: 1 as const, principal: owner.value, delegationId, issuedAt: state.evaluatedAt };
  return { ...record, sig: signature(pair, agentRevocationBytes(record)) };
}
