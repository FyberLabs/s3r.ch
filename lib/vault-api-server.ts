import { createAclStatementSource, type AclStatementConfig } from "./acl-statement-source-server";
import { parseForumAuthorityJson, type SiteAclConfig } from "./site-acl-config";
import { getSiteAclServer } from "./site-acl-server";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { createVaultScopedStore } from "./vault-scoped-store-server";
import { roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { createVaultApiService } from "./vault-api-service";

let cached: { raw: string; site: unknown; service: ReturnType<typeof createVaultApiService> } | undefined;

const vaultKeys = (value: object) => Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).join();

export function getVaultApiService() {
  const raw = process.env.S3RCH_VAULT_STORAGE;
  if (raw === undefined) { cached = undefined; return null; }
  const site = getSiteAclServer();
  if (!site) throw Error("Vault identity unavailable");
  if (cached?.raw === raw && cached.site === site) return cached.service;
  cached = undefined;
  if (raw.length > 65536) throw Error("Invalid vault configuration");
  const config = JSON.parse(raw);
  if (!config || !["apiKey,bindings,origin,tenant", "apiKey,authoritySource,bindings,origin,tenant"].includes(vaultKeys(config)) ||
      !Array.isArray(config.bindings) || config.bindings.length > 128) {
    throw Error("Invalid vault configuration");
  }
  const stores = new Map(config.bindings.map((b: { vaultId: string }) =>
    [b.vaultId, createVaultScopedStore(config, b.vaultId)]));
  const transport = (vaultId: string) => {
    const store = stores.get(vaultId);
    if (!store) throw Error("Unknown vault");
    return store;
  };
  const dedicated = "authoritySource" in config
    ? dedicatedTestVaultAuthority(config.authoritySource, config.tenant, site.config)
    : null;
  const resolve = createVaultApiResolver(dedicated ? { ...dedicated, services: site.services } : site);
  const service = createVaultApiService({ origin: site.config.origin, bindings: config.bindings, transport, resolve });
  cached = { raw, site, service };
  return service;
}

export function dedicatedTestVaultAuthority(input: unknown, tenant: string, site: SiteAclConfig) {
  if (site.origin !== "https://test.s3r.ch" || !input || typeof input !== "object" ||
      Array.isArray(input) || vaultKeys(input) !== "apiKey,authority,origin,scope,tenant") {
    throw Error("Invalid dedicated vault authority source");
  }
  const settings = input as AclStatementConfig & { authority: unknown };
  if (settings.tenant !== tenant || settings.scope !== "s3rch-native-vault") {
    throw Error("Invalid dedicated vault authority binding");
  }
  const authority = parseForumAuthorityJson(JSON.stringify(settings.authority));
  const source = createAclStatementSource({
    origin: settings.origin,
    tenant: settings.tenant,
    scope: settings.scope,
    apiKey: settings.apiKey,
  });
  return {
    config: { origin: site.origin, authority },
    source: {
      async read(at: number, signal: AbortSignal) {
        return (await source.read(at, signal)).snapshot;
      },
    },
  };
}

export function createVaultApiResolver(
  site: {
    config: { authority: ForumAuthorityConfig };
    source: { read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot> };
    services: { authenticate(request: Request): Promise<{ key: string } | null> };
  },
  clock = () => Math.floor(Date.now() / 1000),
) {
  return async (request: Request, signal: AbortSignal) => {
    const at = clock();
    const session = await site.services.authenticate(request);
    if (!session) return null;
    const snapshot = await site.source.read(at, signal);
    const authority = createForumAuthority(site.config.authority, clock);
    const result = await authority.refresh(snapshot, at);
    signal.throwIfAborted();
    if (!result.ok || roomAuthorityReadDiagnosticsBlock(result.diagnostics, snapshot) || clock() !== at) return null;
    const owner = authority.graph.principalForKey(session.key, at);
    return owner ? { owner, key: session.key } : null;
  };
}