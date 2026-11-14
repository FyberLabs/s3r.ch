import type { publicSquadPilotConfig } from "./squad-pilot-config";
export type RoomAuthorityConfig = ReturnType<typeof publicSquadPilotConfig>;
/** Runtime-only public projection; the static feed never embeds deployment config. */
export async function readRoomAuthorityConfig(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RoomAuthorityConfig | null> {
  const response = await fetcher("/api/squad/pilot/room-config", { method: "GET", mode: "same-origin", credentials: "same-origin",
    redirect: "error", cache: "no-store", signal });
  if (!response.ok || response.redirected) { await response.body?.cancel(); return null; }
  const body = await response.json(); signal.throwIfAborted();
  const config = body?.config;
  if (!config || typeof config !== "object" || config.authorityEndpoint !== "/api/squad/pilot/authority" ||
      !config.squad || !config.config || config.sessionBase !== "/api/identity/sea") return null;
  return config;
}
