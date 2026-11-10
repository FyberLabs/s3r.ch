import { createSquadBrowserSource } from "./squad-browser-source";
import { createSquadSessionClient } from "./squad-session-client";
import type { SeaPair } from "./identity/sea";

export type SquadConnectionState = "disconnected" | "connecting" | "connected";
/** Own one connection per mounted Squad/key selection. Session operations are
 * serialized so an earlier exchange cannot install its cookie after a logout.
 * Authority is disabled synchronously, before waiting on any network operation. */
export function createSquadConnection(input: Parameters<typeof createSquadBrowserSource>[0] & {
  origin: string; sessionBase: string; onState?: (state: SquadConnectionState) => void;
}) {
  const browser = createSquadBrowserSource(input);
  const sessions = createSquadSessionClient({ ...input, base: input.sessionBase });
  let generation = 0, disposed = false, pending: AbortController | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined, tail: Promise<unknown> = Promise.resolve();
  let authenticated: { key: string; until: number } | null = null;
  function invalidate() {
    authenticated = null;
    generation++; pending?.abort(); pending = undefined; clearTimeout(expiry);
    browser.deactivate(); input.onState?.("disconnected");
  }
  return Object.freeze({ source: browser.source,
    sessionKey: () => authenticated && Date.now() < authenticated.until ? authenticated.key : null,
    selectKey(pair: SeaPair | null): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      invalidate(); const epoch = generation, selected = pair ? { ...pair } : null;
      if (selected) input.onState?.("connecting");
      const operation = tail.then(async () => {
        if (disposed || epoch !== generation) return false;
        const controller = new AbortController(); pending = controller;
        // Expire from the START of exchange, conservatively before the server's
        // five-minute session limit; never retain the private pair for renewal.
        const started = Date.now();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        let ok: boolean;
        try { ok = selected ? await sessions.signIn(selected, controller.signal) : await sessions.logout(controller.signal); }
        finally { clearTimeout(timeout); }
        if (disposed || epoch !== generation) return false;
        pending = undefined;
        const remaining = 240_000 - (Date.now() - started);
        if (selected && ok && remaining > 0) {
          authenticated = { key: selected.pub, until: started + 240_000 };
          browser.activate(); input.onState?.("connected");
          expiry = setTimeout(() => { if (!disposed && epoch === generation) invalidate(); }, remaining);
          return true;
        }
        input.onState?.("disconnected"); return selected ? false : ok;
      });
      tail = operation.catch(() => {});
      return operation;
    },
    dispose() { if (disposed) return; disposed = true; invalidate(); browser.dispose(); },
  });
}
