import assert from "node:assert/strict";
import test from "node:test";
import { publishForumAuthorized } from "./forum-authorized-publish";
test("revocation arriving during signing prevents publication", async () => {
  let allowed = true, puts = 0, finish!: (sig: string) => void;
  const pending = publishForumAuthorized({ record: { id: "test" }, authorized: () => allowed,
    sign: () => new Promise(resolve => { finish = resolve; }), put: () => { puts++; return true; } });
  allowed = false; finish("signed");
  assert.equal(await pending, "denied"); assert.equal(puts, 0);
});
test("fresh authority publishes once and never signs a denied request", async () => {
  let signs = 0, puts = 0;
  const input = { record: { id: "test" }, authorized: () => false, sign: async () => { signs++; return "signed"; }, put: () => { puts++; return true; } };
  assert.equal(await publishForumAuthorized(input), "denied"); assert.equal(signs, 0);
  assert.equal(await publishForumAuthorized({ ...input, authorized: () => true }), "signed"); assert.equal(signs, 1); assert.equal(puts, 1);
});

import { createForumPublicationFence } from "./forum-publication-fence";
test("closing during signing denies new work and waits for every accepted call", async () => {
  const fence = createForumPublicationFence();
  let finish!: (sig: string) => void, drained = false, puts = 0, signs = 0;
  const input = { fence, record: {}, authorized: () => true,
    sign: () => { signs++; return new Promise<string>(resolve => { finish = resolve; }); }, put: () => { puts++; return true; } };
  const pending = publishForumAuthorized(input);
  const drain = fence.close().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  assert.equal(await publishForumAuthorized(input), "denied"); assert.equal(signs, 1);
  finish("signed"); assert.equal(await pending, "denied"); await drain;
  assert.equal(puts, 0); assert.ok(drained); await fence.close();
});
for (const failure of ["sign", "put", "authorized"] as const) test(`publication exception in ${failure} releases the drain reservation`, async () => {
  const fence = createForumPublicationFence();
  await assert.rejects(publishForumAuthorized({ fence, record: {},
    authorized: () => { if (failure === "authorized") throw Error("test failure"); return true; },
    sign: async () => { if (failure === "sign") throw Error("test failure"); return "signed"; },
    put: () => { if (failure === "put") throw Error("test failure"); return true; },
  }), /test failure/);
  await fence.close(); assert.equal(fence.enter(), null);
});
test("closure inside the final authority callback still fences the put", async () => {
  const fence = createForumPublicationFence(); let calls = 0, puts = 0;
  const result = await publishForumAuthorized({ fence, record: {},
    authorized: () => { if (++calls === 2) void fence.close(); return true; },
    sign: async () => "signed", put: () => { puts++; return true; } });
  assert.equal(result, "denied"); assert.equal(puts, 0); await fence.close();
});
test("drain waits for all concurrent signers, including out-of-order completion", async () => {
  const fence = createForumPublicationFence(), finishes: ((s: string) => void)[] = [];
  let drained = false, puts = 0;
  const input = { fence, record: {}, authorized: () => true,
    sign: () => new Promise<string>(resolve => { finishes.push(resolve); }), put: () => { puts++; return true; } };
  const first = publishForumAuthorized(input), second = publishForumAuthorized(input);
  const drain = fence.close().then(() => { drained = true; });
  finishes[1]("signed"); assert.equal(await second, "denied");
  assert.equal(drained, false);
  finishes[0]("signed"); assert.equal(await first, "denied"); await drain;
  assert.equal(puts, 0); assert.ok(drained);
});
