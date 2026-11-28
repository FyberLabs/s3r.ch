import { authorizeMediaCiphertext } from "./media-ciphertext-authorization";
import { createAllocatedMediaService } from "./allocated-media-service";
import { createAllocatedMediaStore } from "./allocated-media-store-server";
import { createMediaRegistrationStore } from "./media-registration-store";
import { createMediaRegistrationService } from "./media-registration-service";
import { getSiteAclServer } from "./site-acl-server";
import { createSpanopticonObjectStore } from "./spanopticon-object-store-server";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { createMediaObjectService } from "./media-object-service";
import { createMediaAuthority } from "./media-authority-server";
import { configuredTestMediaBinding, getMediaWrapService, getMediaOwnerService, getMediaGroupService } from "./media-wrap-server";

let cached: { identity: string; site: unknown; service: ReturnType<typeof createMediaObjectService> } | undefined;

export function getMediaObjectService() {
  const mode = process.env.S3RCH_MEDIA_STORAGE_MODE;
  if (mode !== undefined && mode !== "allocated-v1") throw Error("Invalid media storage mode");
  const origin = process.env.S3RCH_MEDIA_STORAGE_ORIGIN;
  const tenant = process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;
  const apiKey = process.env.S3RCH_MEDIA_STORAGE_API_KEY;
  if ([origin, tenant, apiKey, mode].every(value => value === undefined)) { cached = undefined; return null; }
  if (!origin || !tenant || !apiKey) throw Error("Media storage unavailable");
  const testBinding = configuredTestMediaBinding(process.env);
  const site = testBinding ? undefined : getSiteAclServer();
  const siteOrigin = testBinding?.siteOrigin ?? site?.config.origin;
  if (!siteOrigin) throw Error("Media authority unavailable");
  const identity = JSON.stringify([origin, tenant, apiKey, mode]);
  if (cached?.identity === identity && cached.site === site) return cached.service;
  cached = undefined;
  const config = { origin, tenant, apiKey };
  if (mode === "allocated-v1") {
    const service = createAllocatedMediaService({
      origin: siteOrigin, allocated: createAllocatedMediaStore(config),
      owner: getMediaOwnerService, wrap: getMediaWrapService, group: getMediaGroupService,
    });
    cached = { identity, site, service };
    return service;
  }
  if (!site) throw Error("Media authority unavailable");
  const records = createSpanopticonRecordStore(config);
  const registrations = createMediaRegistrationStore(records);
  const ownerAuthority = createMediaAuthority({
    config: site.config.authority, authenticate: site.services.authenticate,
    read: site.source.read, registration: registrations.get,
  });
  const authorize: typeof ownerAuthority = async (request, object, action, signal, candidate) => {
    if (action !== "read") return ownerAuthority(request, object, action, signal, candidate);
    return authorizeMediaCiphertext({
      origin: site.config.origin, request, object, signal, wrap: getMediaWrapService, group: getMediaGroupService,
    });
  };
  const objects = createMediaObjectService({
    origin: site.config.origin, objects: createSpanopticonObjectStore(config), records, authorize,
  });
  const register = createMediaRegistrationService({
    origin: site.config.origin, store: registrations, authorize,
    preflight: (request, object, signal) => authorize(request, object, "register", signal),
  });
  const service = (request: Request, object: string) =>
    ["POST", "DELETE"].includes(request.method) ? register(request, object) : objects(request, object);
  cached = { identity, site, service };
  return service;
}