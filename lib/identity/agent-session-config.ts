import { uniqueJson } from "./forum-witness-json";
import type { AclStatementConfig } from "../acl-graph-source-server";
import type { DelegationTrust } from "./acl-delegation-source-server";

const object = (value: unknown, keys: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys) throw Error("Invalid agent session configuration");
  return value as Record<string, unknown>;
};

/** Delegation trust comes from owner history in SociACL, not deployment witnesses. */
const DELEGATION_TRUST: DelegationTrust = Object.freeze({
  jwks: Object.freeze({ keys: Object.freeze([]) }),
  policy: Object.freeze({ allowedDomains: Object.freeze([]), allowedUris: Object.freeze([]), allowedChainIds: Object.freeze([]), clockSkewSeconds: 0 }),
  pinnedIss: new Set<string>(),
});

/** Deployment source binding only. Never accepts request configuration or witness trust. */
export function agentSessionConfig(origin: string, env: Readonly<Record<string, string | undefined>>) {
  const raw = env.S3RCH_AGENT_SESSION_CONFIG, apiKey = env.S3RCH_DELEGATION_SOURCE_API_KEY;
  if (!raw && !apiKey) return undefined;
  if (!raw || !apiKey || Buffer.byteLength(raw) > 65536) throw Error("Incomplete agent session configuration");
  const config = object(uniqueJson(raw), "origin,source");
  if (config.origin !== origin || new URL(origin).origin !== origin || !origin.startsWith("https://")) throw Error("Wrong agent session origin");
  const source = object(config.source, "origin,scope,tenant");
  if (![source.origin, source.scope, source.tenant].every(value => typeof value === "string" && value.length > 0)) throw Error("Invalid delegation source");
  if (Object.hasOwn(config, "authority")) throw Error("Invalid agent session configuration");
  return { source: { ...source, apiKey } as AclStatementConfig, trust: structuredClone(DELEGATION_TRUST) };
}
