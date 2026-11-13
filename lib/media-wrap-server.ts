import { getSquadPilotServer } from "./squad-pilot-server";
import { createForumAuthority } from "./identity/forum-authority";
import { createMediaWrapService, parseMediaReaderConfig } from "./media-wrap-service";

let cached: { raw: string; pilot: unknown; service: ReturnType<typeof createMediaWrapService> } | undefined;
export function getMediaWrapService() {
  const raw = process.env.S3RCH_MEDIA_READER_BINDINGS;
  if (raw === undefined) { cached = undefined; return null; }
  const pilot = getSquadPilotServer();
  if (!pilot) throw Error("Private media identity unavailable");
  if (cached?.raw === raw && cached.pilot === pilot) return cached.service;
  cached = undefined;
  const config = parseMediaReaderConfig(raw);
  if (config.tenant !== process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID || config.tenant !== process.env.S3RCH_MEDIA_STORAGE_TENANT_ID)
    throw Error("Private media tenant mismatch");
  const resolveReader = async (request: Request, signal: AbortSignal) => {
    const at = Math.floor(Date.now() / 1000), session = await pilot.services.authenticate(request);
    if (!session) return null;
    const snapshot = await pilot.source.read(at, signal);
    const authority = createForumAuthority(pilot.config.authority, () => Math.floor(Date.now() / 1000));
    const result = await authority.refresh(snapshot, at);
    signal.throwIfAborted();
    if (!result.ok || result.diagnostics.length || Math.floor(Date.now() / 1000) !== at) return null;
    return authority.graph.principalForKey(session.key, at);
  };
  const service = createMediaWrapService(config, pilot.config.origin, resolveReader);
  cached = { raw, pilot, service }; return service;
}
