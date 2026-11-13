import test from "node:test";
import assert from "node:assert/strict";
import { sendFeedConversion } from "./experiment-navigation";
test("conversion starts immediately and survives the navigation deadline", async () => {
  let started = false, navigated = false;
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const body = { action: "conversion" as const, display: "signed-display", eventId: "stable-id" };
  const work = sendFeedConversion(body, () => { navigated = true; }, async (url, init) => {
    started = true;
    assert.equal(url, "/api/experiments"); assert.equal(init?.keepalive, true);
    assert.equal(init?.signal, undefined); assert.equal(init?.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    return pending;
  }, 1);
  assert.equal(started, true); assert.equal(navigated, false);
  await work; assert.equal(navigated, true);
  finish(new Response(null, { status: 200 }));
});
