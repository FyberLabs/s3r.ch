import { createMediaRegistrationStore } from "./media-registration-store";
import { createMediaRegistrationService } from "./media-registration-service";
import { getSquadPilotServer } from "./squad-pilot-server";
import { createSpanopticonObjectStore } from "./spanopticon-object-store-server";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { createMediaObjectService } from "./media-object-service";
import { createMediaAuthority } from "./media-authority-server";

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
  const authorize = createMediaAuthority({ config: pilot.config.authority, authenticate: pilot.services.authenticate,
    read: pilot.source.read, registration: registrations.get });
  const objects = createMediaObjectService({ origin: pilot.config.origin, objects: createSpanopticonObjectStore(config), records, authorize });
  const register = createMediaRegistrationService({ origin: pilot.config.origin, store: registrations, authorize });
  const service = (request: Request, object: string) => ["POST", "DELETE"].includes(request.method) ? register(request, object) : objects(request, object);
  cached = { identity, pilot, service }; return service;
}
