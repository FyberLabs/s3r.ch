import { createHash } from "node:crypto";

export type IdentityReplay = Readonly<{ challengeDomain: string; consume(id: string, expiresAt: number): Promise<boolean> }>;

/** Server-only, deployment-owned endpoint and dedicated consume-only key. */
export function createSpanopticonIdentityReplay(config: Readonly<{ origin: string; tenant: string; apiKey: string; namespace: string }>,
  fetcher: typeof fetch = fetch, clock = () => Math.floor(Date.now() / 1000)): IdentityReplay {
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.port)
    throw Error("Invalid replay storage origin");
  const { tenant, apiKey, namespace } = config;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) || tenant === "00000000-0000-0000-0000-000000000000" ||
      typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey) || !/^[0-9a-f]{64}$/.test(namespace)) throw Error("Invalid replay storage configuration");
  const base = origin.origin + "/api/v1/storage/replays/" + namespace + "/";
  const challengeDomain = createHash("sha256").update(JSON.stringify(["spanopticon-replay-v1", origin.origin, tenant, namespace])).digest("hex");
  return Object.freeze({ challengeDomain, async consume(id: string, expiresAt: number) {
    const valid = () => { const at = clock(); return Number.isSafeInteger(at) && at >= 0 && Number.isSafeInteger(expiresAt) && at < expiresAt && expiresAt <= at + 60; };
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id) || !valid()) return false;
    const signal = AbortSignal.timeout(10_000);
    let response: Response | undefined;
    try {
      response = await fetcher(base + id, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", signal,
        headers: { "X-Api-Key": apiKey, "X-Tenant-ID": tenant, "X-Replay-Expires-At": String(expiresAt), "Content-Length": "0" } });
      return !signal.aborted && valid() && response.status === 204;
    } catch { return false; }
    finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
  } });
}

export function configuredIdentityReplay(namespace: string, env: Readonly<Record<string, string | undefined>> = process.env, fetcher: typeof fetch = fetch,
  clock = () => Math.floor(Date.now() / 1000)): IdentityReplay | undefined {
  const backend = env.S3RCH_IDENTITY_REPLAY_BACKEND, origin = env.S3RCH_IDENTITY_REPLAY_ORIGIN,
    tenant = env.S3RCH_IDENTITY_REPLAY_TENANT_ID, apiKey = env.S3RCH_IDENTITY_REPLAY_API_KEY;
  if (!backend && !origin && !tenant && !apiKey) return undefined;
  if (backend !== "spanopticon" || !origin || !tenant || !apiKey) throw Error("Incomplete identity replay configuration");
  return createSpanopticonIdentityReplay({ origin, tenant, apiKey, namespace }, fetcher, clock);
}
