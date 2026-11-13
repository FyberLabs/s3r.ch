import { uniqueJson } from "./forum-witness-json";
import type { AclStatementConfig } from "../acl-graph-source-server";
import type { DelegationTrust } from "./acl-delegation-source-server";

const object = (value: unknown, keys: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys) throw Error("Invalid agent session configuration");
  return value as Record<string, unknown>;
};
const strings = (value: unknown, limit: number) => {
  if (!Array.isArray(value) || value.length > limit || !value.every(item => typeof item === "string" && item.length > 0 && item.length <= 2048))
    throw Error("Invalid agent session configuration");
  return value as string[];
};
/** Deployment-only trust and source settings. Never accepts request configuration. */
export function agentSessionConfig(origin: string, env: Readonly<Record<string, string | undefined>>) {
  const raw = env.S3RCH_AGENT_SESSION_CONFIG, apiKey = env.S3RCH_DELEGATION_SOURCE_API_KEY;
  if (!raw && !apiKey) return undefined;
  if (!raw || !apiKey || Buffer.byteLength(raw) > 65536) throw Error("Incomplete agent session configuration");
  const config = object(uniqueJson(raw), "authority,origin,source");
  if (config.origin !== origin || new URL(origin).origin !== origin || !origin.startsWith("https://")) throw Error("Wrong agent session origin");
  const source = object(config.source, "origin,scope,tenant");
  if (![source.origin, source.scope, source.tenant].every(value => typeof value === "string" && value.length > 0)) throw Error("Invalid delegation source");
  const authority = object(config.authority, "jwks,pinnedIss,policy"), jwks = object(authority.jwks, "keys");
  if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 16) throw Error("Invalid witness keys");
  const policy = object(authority.policy, "allowedChainIds,allowedDomains,allowedUris,clockSkewSeconds");
  strings(policy.allowedChainIds,64); strings(policy.allowedDomains,64); strings(policy.allowedUris,64);
  if (!Number.isInteger(policy.clockSkewSeconds) || (policy.clockSkewSeconds as number) < 0 || (policy.clockSkewSeconds as number) > 300) throw Error("Invalid witness skew");
  const pinnedIss = new Set(strings(authority.pinnedIss,16));
  return { source: {...source,apiKey} as AclStatementConfig,
    trust: {jwks,policy,pinnedIss} as DelegationTrust };
}
