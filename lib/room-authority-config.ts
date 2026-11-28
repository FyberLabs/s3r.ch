import { readBoundedIdentityJson } from "./identity/bounded-json";
import type { ForumAuthorityConfig } from "./identity/forum-authority";
import type { LiveSquadSpec } from "./squad-view";

export type RoomAuthorityConfig = {
  origin: string;
  config: ForumAuthorityConfig;
  sessionBase: string;
  authorityEndpoint: string;
  statementEndpoint: string;
  squad: LiveSquadSpec;
};

function parseRoomAuthorityConfig(value: unknown): RoomAuthorityConfig | null {
  if (!value || typeof value !== "object") return null;
  const config = value as Record<string, unknown>;
  if (config.authorityEndpoint !== "/api/site/authority" ||
      config.statementEndpoint !== "/api/site/statement" ||
      config.sessionBase !== "/api/identity/sea" ||
      typeof config.origin !== "string" || !config.config || !config.squad ||
      typeof config.squad !== "object") return null;
  return config as RoomAuthorityConfig;
}

/** Runtime-only public projection; the static feed never embeds deployment config. */
export async function readRoomAuthorityConfig(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RoomAuthorityConfig | null> {
  signal.throwIfAborted();
  const response = await fetcher("/api/site/room-config", { method: "GET", mode: "same-origin", credentials: "same-origin",
    redirect: "error", cache: "no-store", signal });
  if (!response.ok || response.redirected ||
      response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    await response.body?.cancel();
    return null;
  }
  const body = await readBoundedIdentityJson(response, 32768, signal);
  signal.throwIfAborted();
  const config = body && typeof body === "object" && "config" in body ? parseRoomAuthorityConfig((body as { config: unknown }).config) : null;
  return config;
}

export async function loadRoomAuthorityConfig(fetcher: typeof fetch, signal?: AbortSignal) {
  return readRoomAuthorityConfig(signal ?? new AbortController().signal, fetcher);
}