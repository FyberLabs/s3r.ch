import type { SeaPair } from "./sea";
import type { createSeaSessionClient } from "./sea-session-client";

/** User-triggered proof only. No key creation, credential linking or private-key persistence. */
export function createSeaIdentityActivation(input: {
  current(): { pair: SeaPair; revision: number } | null;
  client: Pick<ReturnType<typeof createSeaSessionClient>, "signIn" | "logout">;
}) {
  let busy = false;
  return Object.freeze({ async activate(signal?: AbortSignal, expected?: { principal: string; revision: number }): Promise<"ready" | "locked" | "changed" | "unavailable"> {
    if (busy) return "unavailable";
    const selected = input.current();
    if (!selected) return "locked";
    if (expected && (selected.pair.pub !== expected.principal || selected.revision !== expected.revision)) return "changed";
    const pair = { ...selected.pair }, revision = selected.revision;
    busy = true;
    try {
      const result = await input.client.signIn(pair, signal);
      const current = input.current();
      if (!current || current.revision !== revision || current.pair.pub !== pair.pub) {
        // Finish the stale-exchange cleanup attempt before another activation can start.
        return await input.client.logout(AbortSignal.timeout(10_000)) ? "changed" : "unavailable";
      }
      return result ? "ready" : "unavailable";
    } catch { return "unavailable"; }
    finally { busy = false; }
  } });
}
