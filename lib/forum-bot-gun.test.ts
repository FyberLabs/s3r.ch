import { randomUUID } from "node:crypto";
import type { BotTaskMessage } from "./forum-bot-protocol";
import assert from "node:assert/strict";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createForumBotGunTransport } from "./forum-bot-gun";
import { readForumSignature } from "./forum-sign";
import type { createForumBotWorker } from "./forum-bot-worker";
test("transport watches authorized object IDs and admits parents before cancellation in one batch", async t => {
  const f = await forumBotFixture(t), root = f.task(f.botA), child = f.task(f.botB, root[2]);
  const foreignTask: BotTaskMessage = [...root]; foreignTask[1] = randomUUID();
  const foreign = await f.signed(foreignTask), conflict = await f.signed(root, f.a);
  const first = await f.signed(root), second = await f.signed(child, f.a), cancellation = await f.signed(["cancel", f.tenant, root[2]]);
  const rows = new Map<string, unknown>();
  for (const [row, pair] of [[foreign, f.owner], [first, f.owner], [second, f.a], [conflict, f.a], [cancellation, f.owner]] as const)
    rows.set(row.id, { ...(await readForumSignature(row.signature, pair.pub) as object), sig: row.signature });
  const watched: string[] = [], stopped: string[] = [];
  const chain = (path: string[]): any => ({ get: (key: string) => chain([...path, key]),
    on(receive: (row: unknown) => void) { const id = path.at(-1)!; watched.push(path.join("/")); receive(rows.get(id)); return { off() { stopped.push(id); } }; } });
  const channel = f.open(), order: string[] = [];
  const worker = { deliver: async (links: any) => { const result = await channel.receive(links); order.push("task"); return result; },
    event: async (row: any) => { const result = await channel.event(row); order.push("cancel"); return result; } } as ReturnType<typeof createForumBotWorker>;
  const transport = createForumBotGunTransport({ gun: chain([]), tenant: f.tenant, forum: f.forum, principal: f.b.pub,
    authority: f.auth.graph, principals: [f.owner.pub, f.a.pub, f.b.pub], worker, clock: f.now });
  await transport.tick(); assert.deepEqual(order, ["task", "cancel"]); assert.equal(channel.status(child[2]), "cancelled");
  assert.equal(watched.length, 5); assert.ok(watched.every(path => path.startsWith("s3rch/items/stmt_")));
  await transport.tick(); assert.deepEqual(order, ["task", "cancel"]);
  f.auth.invalidate(); await transport.tick(); assert.equal(stopped.length, 5); transport.close();
});
