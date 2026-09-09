/**
 * Browser consume of same-origin `/api/turn/allocate`.
 *
 * Rule: try the Next hop whenever the SIWE cookie might exist (page load
 * and after sign-in). The route is session-gated. Unsigned / missing env /
 * hop fail → null → keep STUN + `/gun`.
 *
 * Gun `lib/webrtc` sets `opt.rtc` on first opt (`root.once` skips later)
 * and constructs `new RTCPeerConnection(opt.rtc)`. Mutate that same
 * `iceServers` array so later PCs pick up a re-allocate. Do not put
 * credentials on Gun. Do not persist in localStorage.
 */

import {
  GOOGLE_STUN_URL,
  iceServerUrls,
  stunOnlyRtcOptions,
  type BrowserRtcOptions,
  type IceServer,
} from "./gun-webrtc";
import {
  iceServerHasTurn,
  parseAllocateResponse,
  type TurnAllocateOk,
  type TurnIceServer,
} from "./turn-allocate";

export const TURN_ALLOCATE_PATH = "/api/turn/allocate";
export const REALLOCATE_LEAD_MS = 30_000;
export const REALLOCATE_RETRY_MS = 30_000;

export type IceRefreshHandle = {
  stop: () => void;
};

export function iceHasTurn(servers: readonly IceServer[]): boolean {
  return servers.some((server) => iceServerHasTurn(server));
}

export function withGoogleStun(servers: readonly IceServer[]): IceServer[] {
  const hasStun = servers.some((server) =>
    iceServerUrls(server).some((url) => url.startsWith("stun:")),
  );
  if (hasStun) return servers.map((server) => ({ ...server }));
  return [...servers.map((server) => ({ ...server })), { urls: GOOGLE_STUN_URL }];
}

export function rtcOptionsFromAllocation(
  allocation: TurnAllocateOk | null,
): BrowserRtcOptions {
  if (!allocation || allocation.iceServers.length === 0) {
    return stunOnlyRtcOptions();
  }
  return { iceServers: withGoogleStun(allocation.iceServers) };
}

/** Mutate Gun's closed-over `opt.rtc` so new RTCPeerConnections see TURN. */
export function applyRtcIceServers(
  rtc: BrowserRtcOptions,
  servers: readonly TurnIceServer[],
): void {
  rtc.iceServers = withGoogleStun(servers);
}

export function msUntilReallocate(
  expiresAt: string,
  now = Date.now(),
  leadMs = REALLOCATE_LEAD_MS,
): number {
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return 0;
  return Math.max(0, exp - now - leadMs);
}

export async function fetchTurnAllocate(
  load: typeof fetch = fetch,
): Promise<TurnAllocateOk | null> {
  try {
    const response = await load(TURN_ALLOCATE_PATH, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return parseAllocateResponse(await response.json());
  } catch {
    return null;
  }
}

export function startTurnIceRefresh(input: {
  rtc: BrowserRtcOptions;
  expiresAt: string | null;
  fetchAllocate?: () => Promise<TurnAllocateOk | null>;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onApplied?: (allocation: TurnAllocateOk) => void;
}): IceRefreshHandle {
  const setTimer = input.setTimeoutFn ?? setTimeout;
  const clearTimer = input.clearTimeoutFn ?? clearTimeout;
  const fetchAllocate = input.fetchAllocate ?? fetchTurnAllocate;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = (expiresAt: string | null) => {
    if (stopped || !expiresAt) return;
    const wait = msUntilReallocate(expiresAt, input.now?.() ?? Date.now());
    timer = setTimer(() => {
      void (async () => {
        const next = await fetchAllocate();
        if (stopped) return;
        if (next) {
          applyRtcIceServers(input.rtc, next.iceServers);
          input.onApplied?.(next);
          arm(next.expiresAt);
          return;
        }
        const retryAt = (input.now?.() ?? Date.now()) + REALLOCATE_RETRY_MS + REALLOCATE_LEAD_MS;
        arm(new Date(retryAt).toISOString());
      })();
    }, wait);
  };

  arm(input.expiresAt);
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
    },
  };
}
