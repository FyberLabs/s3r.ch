import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { createAclCredentialSource, type AclCredentialConfig } from "./acl-credential-source-server";
import { createLinkedSessionAdmission } from "./linked-session-admission";
import type { DelegationTrust } from "./acl-delegation-source-server";

const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Invalid linked identity configuration");
  return v as Record<string, unknown>;
};
const fields = (v: Record<string, unknown>, names: string) => {
  if (Object.keys(v).sort().join() !== names) throw Error("Invalid linked identity configuration");
};
const strings = (v: unknown, max: number): string[] => {
  if (!Array.isArray(v) || v.length > max || v.some(x => typeof x !== "string" || !x || x.length > 4096)) throw Error("Invalid linked identity configuration");
  return [...v];
};
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` :
  v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

/** Protected operator configuration supplies trust and the complete source.
 * An absent file setting performs no IO and leaves linked login unavailable. */
export async function configuredLinkedAdmission(origin: string, env: Readonly<Record<string, string | undefined>>,
  fetcher: typeof fetch = fetch, clock = () => Math.floor(Date.now() / 1000)) {
  const path = env.S3RCH_LINKED_IDENTITY_CONFIG_FILE;
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) throw Error("Invalid linked identity configuration path");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > 65536) throw Error("Unprotected linked identity configuration");
    const bytes = new Uint8Array(65537); let used = 0;
    for (;;) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
      if (used > 65536) throw Error("Linked identity configuration too large");
    }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } finally { await file.close(); }
  const config = object(JSON.parse(raw));
  if (canonical(config) + "\n" !== raw) throw Error("Noncanonical linked identity configuration");
  fields(config, "oidc,origin,source,trust,version,walletChainIds");
  if (config.version !== 1 || config.origin !== origin) throw Error("Foreign linked identity configuration");
  const supplied = object(config.trust); fields(supplied, "jwks,pinnedIss,policy");
  const trust = { jwks: object(supplied.jwks), policy: object(supplied.policy), pinnedIss: new Set(strings(supplied.pinnedIss, 16)) } as unknown as DelegationTrust;
  const source = createAclCredentialSource(object(config.source) as AclCredentialConfig, trust, fetcher, clock);
  if (!Array.isArray(config.oidc) || config.oidc.length > 16) throw Error("Invalid linked providers");
  const oidc = config.oidc.map(raw => {
    const row = object(raw); fields(row, "clientId,issuer,jwks,tenant,tenantClaim");
    for (const name of ["clientId", "issuer", "tenant", "tenantClaim"]) strings([row[name]], 1);
    const issuer = new URL(row.issuer as string);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) throw Error("Invalid linked provider");
    return { issuer: row.issuer as string, clientId: row.clientId as string, tenant: row.tenant as string,
      tenantClaim: row.tenantClaim as string, key: createLocalJWKSet(object(row.jwks) as unknown as JSONWebKeySet) };
  });
  if (new Set(oidc.map(row => JSON.stringify([row.issuer, row.tenant]))).size !== oidc.length) throw Error("Ambiguous linked provider");
  return createLinkedSessionAdmission({ source, origin, walletChainIds: strings(config.walletChainIds, 32), oidc });
}
