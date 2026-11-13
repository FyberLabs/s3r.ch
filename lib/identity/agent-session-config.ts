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

function witnessKey(value: unknown): DelegationTrust["jwks"]["keys"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid witness key");
  const key=value as Record<string,unknown>;
  if (Object.keys(key).some(name=>!["kty","crv","kid","x","y","notBefore","notAfter","alg","use","key_ops"].includes(name)) ||
      key.kty!=="EC" || key.crv!=="P-256" || typeof key.kid!=="string" || !key.kid || key.kid.length>256 ||
      typeof key.x!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || typeof key.y!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(key.y) ||
      !Number.isSafeInteger(key.notBefore) || !Number.isSafeInteger(key.notAfter) || (key.notBefore as number)<0 || (key.notAfter as number)<=(key.notBefore as number) ||
      (key.alg!==undefined && key.alg!=="ES256") || (key.use!==undefined && key.use!=="sig") ||
      (key.key_ops!==undefined && (!Array.isArray(key.key_ops) || key.key_ops.length!==1 || key.key_ops[0]!=="verify")))
    throw Error("Invalid witness key");
  return {kty:"EC",crv:"P-256",kid:key.kid,x:key.x,y:key.y,notBefore:key.notBefore as number,notAfter:key.notAfter as number,
    ...(key.alg===undefined?{}:{alg:"ES256" as const}),...(key.use===undefined?{}:{use:"sig" as const}),
    ...(key.key_ops===undefined?{}:{key_ops:["verify"]})};
}

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
  const keys=jwks.keys.map(witnessKey);
  if(new Set(keys.map(key=>key.kid)).size!==keys.length) throw Error("Duplicate witness key");
  const policy = object(authority.policy, "allowedChainIds,allowedDomains,allowedUris,clockSkewSeconds");
  const allowedChainIds=strings(policy.allowedChainIds,64), allowedDomains=strings(policy.allowedDomains,64), allowedUris=strings(policy.allowedUris,64);
  if (!Number.isInteger(policy.clockSkewSeconds) || (policy.clockSkewSeconds as number) < 0 || (policy.clockSkewSeconds as number) > 300) throw Error("Invalid witness skew");
  const pinnedIss = new Set(strings(authority.pinnedIss,16));
  return { source: {...source,apiKey} as AclStatementConfig,
    trust: {jwks:{keys},policy:{allowedChainIds,allowedDomains,allowedUris,clockSkewSeconds:policy.clockSkewSeconds as number},pinnedIss} };
}
