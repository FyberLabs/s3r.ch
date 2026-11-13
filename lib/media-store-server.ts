import { createMediaRegistrationStore } from "./media-registration-store";
import { createMediaRegistrationService } from "./media-registration-service";
import { getSquadPilotServer } from "./squad-pilot-server";
import { createSpanopticonObjectStore } from "./spanopticon-object-store-server";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { createMediaObjectService } from "./media-object-service";
import { createMediaAuthority } from "./media-authority-server";
import { getMediaWrapService } from "./media-wrap-server";

let cached: { identity: string; pilot: unknown; service: ReturnType<typeof createMediaObjectService> } | undefined;
/** Disabled until deployment stages a dedicated media credential. Never reuse
 * feed-cache, Oracles, replay, or browser credentials for private media. */
export function getMediaObjectService() {
  const origin = process.env.S3RCH_MEDIA_STORAGE_ORIGIN, tenant = process.env.S3RCH_MEDIA_STORAGE_TENANT_ID,
    apiKey = process.env.S3RCH_MEDIA_STORAGE_API_KEY;
  if ([origin, tenant, apiKey].every(value => value === undefined)) { cached = undefined; return null; }
  if (!origin || !tenant || !apiKey) throw Error("Media storage unavailable");
  const pilot = getSquadPilotServer();
  if (!pilot) throw Error("Media authority unavailable");
  const identity = JSON.stringify([origin, tenant, apiKey]);
  if (cached?.identity === identity && cached.pilot === pilot) return cached.service;
  cached = undefined;
  const config = { origin, tenant, apiKey };
  const records = createSpanopticonRecordStore(config), registrations = createMediaRegistrationStore(records);
  const ownerAuthority = createMediaAuthority({ config: pilot.config.authority, authenticate: pilot.services.authenticate,
    read: pilot.source.read, registration: registrations.get });
  const authorize: typeof ownerAuthority = async (request, object, action, signal, candidate) => {
    if (action !== "read") return ownerAuthority(request, object, action, signal, candidate);
    const service = getMediaWrapService();
    if (!service) return false;
    // Object-service ingress has already checked the browser origin. Private
    // reads require the same protected grant as wrap delivery, not a public See.
    const headers = new Headers(request.headers);
    headers.set("origin", pilot.config.origin); headers.set("content-type", "application/json");
    headers.delete("content-length"); headers.delete("content-encoding");
    const response = await service(new Request(pilot.config.origin + "/api/media/read-wrap", {
      method: "POST", headers, body: JSON.stringify({ object }), signal,
    }));
    try { signal.throwIfAborted(); return response.status === 200; }
    finally { await response.body?.cancel().catch(() => {}); }
  };
  const objects = createMediaObjectService({ origin: pilot.config.origin, objects: createSpanopticonObjectStore(config), records, authorize });
  const register = createMediaRegistrationService({ origin: pilot.config.origin, store: registrations, authorize,
    preflight: (request, object, signal) => authorize(request, object, "register", signal) });
  const service = (request: Request, object: string) => ["POST", "DELETE"].includes(request.method) ? register(request, object) : objects(request, object);
  cached = { identity, pilot, service }; return service;
}
