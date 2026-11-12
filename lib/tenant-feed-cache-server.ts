import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { createAzureRecordStore } from "./azure-record-store-server";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { tenantFeedCache } from "./tenant-feed-cache";
import { getMemoryStore, publishAuthoritativeFeed, markTenantFeedAdopted } from "./gun-server";

/** Legacy disk mode remains until deployment installs the dedicated record key. */
export function feedCacheSettings(env: Record<string, string | undefined> = process.env) {
  const origin = env.S3RCH_FEED_STORAGE_ORIGIN, tenant = env.S3RCH_FEED_STORAGE_TENANT_ID,
    apiKey = env.S3RCH_FEED_STORAGE_API_KEY, backend = env.S3RCH_FEED_STORAGE_BACKEND,
    account = env.S3RCH_FEED_STORAGE_AZURE_ACCOUNT, container = env.S3RCH_FEED_STORAGE_AZURE_CONTAINER;
  if (backend === "azure") {
    if (origin || apiKey || !tenant || !account || !/^[a-z0-9]{3,24}$/.test(account) ||
        !container || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(container) || container.includes("--"))
      throw new Error("Invalid public feed storage configuration");
    return { backend: "azure" as const, account, container, tenant };
  }
  if (account || container) throw new Error("Invalid public feed storage configuration");
  if (backend === "filesystem" && !origin && !tenant && !apiKey) return null;
  if (backend === undefined && !origin && !tenant && !apiKey) return null;
  if ((backend !== undefined && backend !== "spanopticon") || !origin || !tenant || !apiKey) throw new Error("Invalid public feed storage configuration");
  return { backend: "spanopticon" as const, origin, tenant, apiKey };
}
let cache: ReturnType<typeof tenantFeedCache> | undefined;
export function configuredTenantFeedCache() {
  const config = feedCacheSettings();
  if (!config) return null;
  if (cache) return cache;
  const records = config.backend === "azure"
    ? createAzureRecordStore(new BlobServiceClient(`https://${config.account}.blob.core.windows.net`, new DefaultAzureCredential(),
        { retryOptions: { maxTries: 1 } }).getContainerClient(config.container), config.tenant)
    : createSpanopticonRecordStore(config);
  return cache = tenantFeedCache(records, getMemoryStore, publishAuthoritativeFeed, markTenantFeedAdopted);
}
let restoration: Promise<void> | undefined;
export function restoreTenantFeedCache(): Promise<void> {
  return restoration ??= Promise.resolve().then(async () => { await configuredTenantFeedCache()?.restore(); });
}
export async function waitForTenantFeedRestore(): Promise<void> {
  // Refreshes wait for startup restore, while public reads remain available.
  await restoration?.catch(() => {});
}
