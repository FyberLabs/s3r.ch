import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpAssignmentClient } from "./assignment-client";
const key = "FE5EULsrrD5LgQOpCivsikXM7tqbCHauMTuyNEmQg2c.ke9ir6B2WZPgRYyxC-OykqiV_HSGgYj_ohUyw2giL8Y", scope = { forum: "test", owner: key }, id = "a".repeat(32);
const receipt = { operationId: id, replacement: key, revision: "2", evaluatedAt: 100 };
const client = (body: unknown, status = 200) => createHttpAssignmentClient({ base: "/test", fetch: async () => new Response(JSON.stringify(body), { status }) });
test("completion requires a receipt bound to the requested operation and replacement", async () => {
  assert.deepEqual(await client({ status: "complete", receipt }).resume(scope, id, key), { status: "complete", receipt });
  for (const bad of [null, {}, { status: "complete" }, { status: "complete", receipt: { ...receipt, operationId: "b".repeat(32) } },
    { status: "complete", receipt: { ...receipt, replacement: "foreign" } }, { status: "complete", receipt: { ...receipt, revision: "" } }])
    await assert.rejects(client(bad).resume(scope, id, key));
});
test("foreign or malformed state and failed child admission never become success", async () => {
  await assert.rejects(client({ ...scope, forum: "foreign", assignee: key, revision: 1, operation: null, receipts: {} }).read(scope));
  await assert.rejects(client({ ...scope, assignee: key, revision: 1, operation: false, receipts: {} }).read(scope));
  await assert.rejects(client({}, 403).read(scope), /owner/);
});
