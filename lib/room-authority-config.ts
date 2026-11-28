import type { publicSiteClientConfig } from "./site-acl-config";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function loadRoomAuthorityConfig(fetcher: Fetcher, signal?: AbortSignal) {
  const response = await fetcher("/api/site/room-config", { method: "GET", mode: "same-origin", credentials: "same-origin",
    cache: "no-store", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw Error("Room authority configuration unavailable");
  const body = await response.json();
  const config = body?.config;
  if (!config || typeof config !== "object" || config.authorityEndpoint !== "/api/site/authority" ||
      config.statementEndpoint !== "/api/site/statement" || config.sessionBase !== "/api/identity/sea") return null;
  return config as ReturnType<typeof publicSiteClientConfig>;
}