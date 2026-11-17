import { getSquadPilotServer } from "./squad-pilot-server";
import { createForumAuthority } from "./identity/forum-authority";
import { createMediaWrapService, parseMediaReaderConfig } from "./media-wrap-service";
import { createMediaAgentRead } from "./media-agent-read";
import { authenticateAgentRequest } from "./identity/site-agent-session-server";

import { createMediaGroupService } from "./media-group-service";

import { createMediaOwnerService } from "./media-owner-service";

let cached: { raw: string; pilot: unknown; service: ReturnType<typeof createMediaWrapService>; owner: ReturnType<typeof createMediaOwnerService>; group: ReturnType<typeof createMediaGroupService> } | undefined;
function getMediaServices() {
  const raw = process.env.S3RCH_MEDIA_READER_BINDINGS;
  if (raw === undefined) { cached = undefined; return null; }
  const pilot = getSquadPilotServer();
  if (!pilot) throw Error("Private media identity unavailable");
  if (cached?.raw === raw && cached.pilot === pilot) return cached;
  cached = undefined;
  const config = parseMediaReaderConfig(raw);
  if (config.tenant !== process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID || config.tenant !== process.env.S3RCH_MEDIA_STORAGE_TENANT_ID)
    throw Error("Private media tenant mismatch");
  const resolveReader = async (request: Request, signal: AbortSignal) => {
    // A rejected bearer must never fall back to an ambient browser owner cookie.
    if (request.headers.has("authorization")) return null;
    const at = Math.floor(Date.now() / 1000), session = await pilot.services.authenticate(request);
    if (!session) return null;
    const snapshot = await pilot.source.read(at, signal);
    const authority = createForumAuthority(pilot.config.authority, () => Math.floor(Date.now() / 1000));
    const result = await authority.refresh(snapshot, at);
    signal.throwIfAborted();
    if (!result.ok || result.diagnostics.length || Math.floor(Date.now() / 1000) !== at) return null;
    return authority.graph.principalForKey(session.key, at);
  };
  const browser = createMediaWrapService(config, pilot.config.origin, resolveReader);
  const agent = createMediaAgentRead(config, pilot.config.origin,
    request => authenticateAgentRequest(request, ["media:read"]));
  const service: ReturnType<typeof createMediaWrapService> = (request, action = "read-wrap") => {
    if (!request.headers.has("authorization")) return browser(request, action);
    if (action === "read-wrap") return agent(request);
    return Promise.resolve(new Response(null, { status: 403, headers: {
      "Cache-Control": "private, no-store", Vary: "Authorization, Cookie, Origin",
    } }));
  };
  const owner = createMediaOwnerService(config, pilot.config.origin, resolveReader);
  const group = createMediaGroupService(config, pilot.config.origin, resolveReader);
  cached = { raw, pilot, service, owner, group }; return cached;
}

export function getMediaWrapService() { return getMediaServices()?.service ?? null; }
export function getMediaOwnerService() { return getMediaServices()?.owner ?? null; }

export function getMediaGroupService() { return getMediaServices()?.group ?? null; }
