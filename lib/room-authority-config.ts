import { readBoundedIdentityJson } from "./identity/bounded-json";
import type { publicSquadPilotConfig } from "./squad-pilot-config";
export type RoomAuthorityConfig = ReturnType<typeof publicSquadPilotConfig>;
/** Runtime-only public projection; the static feed never embeds deployment config. */
export async function readRoomAuthorityConfig(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RoomAuthorityConfig | null> {
  signal.throwIfAborted();
  const response = await fetcher("/api/squad/pilot/room-config", { method: "GET", mode: "same-origin", credentials: "same-origin",
    redirect: "error", cache: "no-store", signal });
  if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") { await response.body?.cancel(); return null; }
  const body = await readBoundedIdentityJson(response, 32768, signal); signal.throwIfAborted();
  const config = body && typeof body === "object" && "config" in body ? body.config as RoomAuthorityConfig : null;
  if (!config || typeof config !== "object" || config.authorityEndpoint !== "/api/squad/pilot/authority" ||
      !config.squad || !config.config || config.sessionBase !== "/api/identity/sea") return null;
  return config;
}
