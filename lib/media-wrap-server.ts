import { getSiteAclServer } from "./site-acl-server";
import { createForumAuthority } from "./identity/forum-authority";
import { createMediaWrapService, parseMediaReaderConfig } from "./media-wrap-service";
import { createMediaAgentRead } from "./media-agent-read";
import { authenticateAgentRequest } from "./identity/site-agent-session-server";
import { readSeaSessionCookie } from "./identity/sea-session-http";
import { createIdentityTokenVerifier } from "./identity/sea-session-verifier";
import { getIdentitySecret } from "./identity/secret";
import { matchesRequestOrigin } from "./request-origin";

import { createMediaGroupService } from "./media-group-service";

import { createMediaOwnerService } from "./media-owner-service";

let cached: { raw: string; identity: unknown; service: ReturnType<typeof createMediaWrapService>; owner: ReturnType<typeof createMediaOwnerService>; group: ReturnType<typeof createMediaGroupService> } | undefined;

const testMediaTenant = "afee9b29-1706-5590-bbbf-e58df8945ac0";
const testMediaGateway = "https://api.test.hyperme.sh";
const testMediaSite = new URL("https://test.s3r.ch");

export function configuredTestMediaBinding(env: Record<string, string | undefined>) {
  const principal = env.S3RCH_TEST_MEDIA_OWNER_PRINCIPAL;
  const apiKey = env.S3RCH_TEST_MEDIA_ACL_API_KEY;
  if (principal === undefined && apiKey === undefined) return undefined;
  if (env.S3RCH_MEDIA_READER_BINDINGS !== undefined || env.WEBSITE_SITE_NAME !== "s3rch-fyberlabs-test" ||
      env.S3RCH_MEDIA_STORAGE_MODE !== "allocated-v1" || env.S3RCH_MEDIA_STORAGE_ORIGIN !== testMediaGateway ||
      env.S3RCH_IDENTITY_REPLAY_BACKEND !== "spanopticon" || env.S3RCH_IDENTITY_REPLAY_TENANT_ID !== testMediaTenant ||
      env.S3RCH_MEDIA_STORAGE_TENANT_ID !== testMediaTenant ||
      !principal || !apiKey || apiKey.startsWith("@Microsoft.KeyVault(")) {
    throw Error("Synthetic TEST media binding unavailable");
  }
  const raw = JSON.stringify({ origin: testMediaGateway, tenant: testMediaTenant, readers: [{ principal, apiKey }] });
  parseMediaReaderConfig(raw);
  return { raw, principal, siteOrigin: testMediaSite.origin };
}

export function createTestMediaReader(principal: string, secret: string, clock?: () => number) {
  if (secret.startsWith("@Microsoft.KeyVault(")) throw Error("TEST identity session secret unavailable");
  const verifier = createIdentityTokenVerifier({ origin: testMediaSite.origin, secret, clock });
  return async (request: Request, signal: AbortSignal) => {
    if (request.headers.has("authorization") || !matchesRequestOrigin(request, testMediaSite)) return null;
    const token = readSeaSessionCookie(request);
    if (!token) return null;
    const session = await verifier.authenticate(token);
    signal.throwIfAborted();
    return session?.key === principal ? principal : null;
  };
}

function getMediaServices() {
  const testBinding = configuredTestMediaBinding(process.env);
  const raw = testBinding?.raw ?? process.env.S3RCH_MEDIA_READER_BINDINGS;
  if (raw === undefined) { cached = undefined; return null; }
  const site = testBinding ? undefined : getSiteAclServer();
  const siteOrigin = testBinding?.siteOrigin ?? site?.config.origin;
  if (!siteOrigin) throw Error("Private media identity unavailable");
  const secret = testBinding ? getIdentitySecret({
    S3RCH_SESSION_SIGNING_KEY: process.env.S3RCH_SESSION_SIGNING_KEY, NODE_ENV: "production",
  }) : undefined;
  const identity = secret ?? site;
  if (cached?.raw === raw && cached.identity === identity) return cached;
  cached = undefined;
  const config = parseMediaReaderConfig(raw);
  if ((!testBinding && config.tenant !== process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID) ||
      config.tenant !== process.env.S3RCH_MEDIA_STORAGE_TENANT_ID)
    throw Error("Private media tenant mismatch");
  const resolveReader = testBinding && secret ? createTestMediaReader(testBinding.principal, secret) : async (request: Request, signal: AbortSignal) => {
    // A rejected bearer must never fall back to an ambient browser owner cookie.
    if (request.headers.has("authorization") || !site) return null;
    const at = Math.floor(Date.now() / 1000);
    const session = await site.services.authenticate(request);
    if (!session) return null;
    const snapshot = await site.source.read(at, signal);
    const authority = createForumAuthority(site.config.authority, () => Math.floor(Date.now() / 1000));
    const result = await authority.refresh(snapshot, at);
    signal.throwIfAborted();
    if (!result.ok || result.diagnostics.length || Math.floor(Date.now() / 1000) !== at) return null;
    return authority.graph.principalForKey(session.key, at);
  };
  const browser = createMediaWrapService(config, siteOrigin, resolveReader);
  const agent = createMediaAgentRead(config, siteOrigin,
    request => authenticateAgentRequest(request, ["media:read"]));
  const service: ReturnType<typeof createMediaWrapService> = (request, action = "read-wrap") => {
    if (!request.headers.has("authorization")) return browser(request, action);
    if (action === "read-wrap" && !testBinding) return agent(request);
    return Promise.resolve(new Response(null, { status: 403, headers: {
      "Cache-Control": "private, no-store", Vary: "Authorization, Cookie, Origin",
    } }));
  };
  const owner = createMediaOwnerService(config, siteOrigin, resolveReader);
  const group = createMediaGroupService(config, siteOrigin, resolveReader);
  cached = { raw, identity, service, owner, group }; return cached;
}

export function getMediaWrapService() { return getMediaServices()?.service ?? null; }
export function getMediaOwnerService() { return getMediaServices()?.owner ?? null; }

export function getMediaGroupService() { return getMediaServices()?.group ?? null; }
