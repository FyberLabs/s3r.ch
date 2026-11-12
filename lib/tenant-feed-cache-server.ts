import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { tenantFeedCache } from "./tenant-feed-cache";
import { getMemoryStore, publishAuthoritativeFeed } from "./gun-server";

/** Legacy disk mode remains until deployment installs the dedicated record key. */
export function feedCacheSettings(env: Record<string, string | undefined> = process.env) {
  const origin = env.S3RCH_FEED_STORAGE_ORIGIN, tenant = env.S3RCH_FEED_STORAGE_TENANT_ID,
    apiKey = env.S3RCH_FEED_STORAGE_API_KEY, backend = env.S3RCH_FEED_STORAGE_BACKEND;
  if (backend === "filesystem" && !origin && !tenant && !apiKey) return null;
  if (backend === undefined && !origin && !tenant && !apiKey) return null;
  if ((backend !== undefined && backend !== "spanopticon") || !origin || !tenant || !apiKey) throw new Error("Invalid public feed storage configuration");
  return { origin, tenant, apiKey };
}
let cache: ReturnType<typeof tenantFeedCache> | undefined;
export function configuredTenantFeedCache() {
  const config = feedCacheSettings();
  if (!config) return null;
  return cache ??= tenantFeedCache(createSpanopticonRecordStore(config), getMemoryStore, publishAuthoritativeFeed);
}
export async function restoreTenantFeedCache() {
  await configuredTenantFeedCache()?.restore();
}
