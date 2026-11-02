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
