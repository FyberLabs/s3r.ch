/** Server-evaluated SIWE deployment policy; never a NEXT_PUBLIC setting. */
import { ALLOWED_SIWE_HOSTS } from "./config";

export type SiwePolicy = {
  hosts: ReadonlySet<string>;
  origins: ReadonlySet<string> | null;
  contractChainId: 1;
  rpcUrl?: string;
};

export function readSiwePolicy(env: Record<string, string | undefined>): SiwePolicy {
  const raw = env.S3RCH_SIWE_POLICY;
  if (raw === undefined) return { hosts: ALLOWED_SIWE_HOSTS, origins: null, contractChainId: 1 };
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid SIWE policy");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["allowed_hosts", "allowed_origins", "contract_chain_id", "rpc_url"].includes(k)) ||
      v.contract_chain_id !== 1 || !Array.isArray(v.allowed_hosts) || !v.allowed_hosts.length ||
      !Array.isArray(v.allowed_origins) || !v.allowed_origins.length) throw new Error("Invalid SIWE policy");
  const hosts = new Set<string>();
  for (const host of v.allowed_hosts) {
    if (typeof host !== "string" || !ALLOWED_SIWE_HOSTS.has(host) || hosts.has(host)) throw new Error("Invalid SIWE host");
    hosts.add(host);
  }
  const origins = new Set<string>();
  const represented = new Set<string>();
  for (const origin of v.allowed_origins) {
    if (typeof origin !== "string") throw new Error("Invalid SIWE origin");
    const url = new URL(origin);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.origin !== origin || url.username || url.password || !hosts.has(url.hostname) ||
        (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
        (!local && url.port) || origins.has(origin)) throw new Error("Invalid SIWE origin");
    origins.add(origin); represented.add(url.hostname);
  }
  if (represented.size !== hosts.size) throw new Error("SIWE host lacks an origin");
  let rpcUrl: string | undefined;
  if (v.rpc_url !== undefined && v.rpc_url !== null) {
    if (typeof v.rpc_url !== "string") throw new Error("Invalid SIWE RPC");
    const url = new URL(v.rpc_url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid SIWE RPC");
    rpcUrl = v.rpc_url;
  }
  return { hosts, origins, contractChainId: 1, rpcUrl };
}

export function policyAllowsMessage(policy: SiwePolicy, domain: string, uri: string): boolean {
  if (!policy.hosts.has(domain.split(":")[0].toLowerCase())) return false;
  if (policy.origins === null) return true; // Preserve the unconfigured owner contract.
  try {
    const url = new URL(uri);
    return policy.origins.has(uri) && url.host.toLowerCase() === domain.toLowerCase();
  } catch { return false; }
}
