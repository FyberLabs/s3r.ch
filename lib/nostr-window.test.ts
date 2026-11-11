import assert from "node:assert/strict";
import test from "node:test";
import { queryNostrRelay } from "./nostr";

for (const mode of ["eose", "close", "error", "timeout"] as const) {
  test(`Nostr window requires EOSE after events: ${mode}`, async t => {
    const original = globalThis.WebSocket;
    const event = { id: "a".repeat(64), kind: 1 };
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(data: string) {
        const [type, id] = JSON.parse(data);
        if (type !== "REQ") return;
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EVENT", id, event]) }));
        if (mode === "eose") this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EOSE", id]) }));
        else if (mode !== "timeout") this.dispatchEvent(new Event(mode));
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    t.after(() => { globalThis.WebSocket = original; });
    if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = queryNostrRelay("wss://example.org", { authors: ["b".repeat(64)], kinds: [1], limit: 20 });
    if (mode === "eose") assert.deepEqual(await result, [event]);
    else {
      const rejected = assert.rejects(result, /closed before EOSE|WebSocket error|timed out/);
      if (mode === "timeout") { await Promise.resolve(); t.mock.timers.tick(15000); }
      await rejected;
    }
  });
}
