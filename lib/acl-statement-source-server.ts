import { ManagedIdentityCredential } from "@azure/identity";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
import { createAclGraphSource, type AclStatementConfig, type StatementKeyReader } from "./acl-graph-source-server";
export { StatementSourceConflict, type AclStatementConfig } from "./acl-graph-source-server";

export function createAclStatementSource(input: AclStatementConfig, fetcher: typeof fetch = fetch,
  clock = () => Math.floor(Date.now() / 1000)) {
  const source = createAclGraphSource(input, "statements", fetcher, clock);
  return Object.freeze({ ...source, async read(at: number, signal: AbortSignal) {
    const result = await source.read(at, signal);
    return { ...result, snapshot: result.snapshot as ForumAuthoritySnapshot };
  } });
}

export function configuredAclStatementSource(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch) {
  const backend = env.S3RCH_AUTHORITY_BACKEND;
  if (!backend || backend === "legacy") return undefined;
  if (backend !== "acl") throw Error("Unknown authority backend");
  const key = env.S3RCH_STATEMENT_SOURCE_API_KEY;
  const secretUri = env.S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI;
  if (key && secretUri) throw Error("Configure only one statement source credential");
  const config = { origin: env.S3RCH_STATEMENT_SOURCE_ORIGIN, tenant: env.S3RCH_STATEMENT_SOURCE_TENANT_ID,
    scope: env.S3RCH_STATEMENT_SOURCE_SCOPE, apiKey: secretUri ? vaultStatementKey(secretUri, env.AZURE_CLIENT_ID, fetcher) : key };
  if (Object.values(config).some(value => !value)) throw Error("Statement source not configured");
  return createAclStatementSource(config as AclStatementConfig, fetcher);
}

function vaultStatementKey(uri: string, clientId: string | undefined, fetcher: typeof fetch): StatementKeyReader {
  const url = new URL(uri);
  if (uri !== url.origin + url.pathname || url.protocol !== "https:" || url.port ||
    !/^[a-z][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net$/.test(url.hostname) ||
    !/^\/secrets\/[a-zA-Z0-9-]{1,127}$/.test(url.pathname) || !clientId) {
    throw Error("Invalid statement source Key Vault configuration");
  }
  url.searchParams.set("api-version", "7.4");
  const credential = new ManagedIdentityCredential({ clientId });
  let cached: { value: string; expires: number } | undefined;
  return async (signal) => {
    signal.throwIfAborted();
    if (cached && Date.now() < cached.expires) return cached.value;
    const token = await credential.getToken("https://vault.azure.net/.default", { abortSignal: signal });
    signal.throwIfAborted();
    const response = await fetcher(url, {
      signal, redirect: "error", cache: "no-store", credentials: "omit",
      headers: { Authorization: "Bearer " + token.token },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("Statement source key unavailable");
    }
    const { value } = await response.json();
    signal.throwIfAborted();
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(value)) {
      throw Error("Statement source key unavailable");
    }
    cached = { value, expires: Date.now() + 30_000 };
    return value;
  };
}
