import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
import { createAclGraphSource, type AclStatementConfig } from "./acl-graph-source-server";
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
  const config = { origin: env.S3RCH_STATEMENT_SOURCE_ORIGIN, tenant: env.S3RCH_STATEMENT_SOURCE_TENANT_ID,
    scope: env.S3RCH_STATEMENT_SOURCE_SCOPE, apiKey: env.S3RCH_STATEMENT_SOURCE_API_KEY };
  if (Object.values(config).some(value => !value)) throw Error("Statement source not configured");
  return createAclStatementSource(config as AclStatementConfig, fetcher);
}
