import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createRoomChatReplay, ROOM_REPLAY_PAGE_ROWS } from "./room-chat-replay";
import { createRoomChatAdmission } from "./room-chat-admission";
import { encodeKey } from "./identity/check";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import type { SeaPair } from "./identity/sea";
const sea = createRequire(import.meta.url)("gun/sea") as {pair(): Promise<SeaPair>};
async function fixture() {
  const pair = await sea.pair();
  const graph = {writerKey: (p: string) => p === pair.pub ? p : null,
    principalForKey: (p: string) => p === pair.pub ? p : null,
    checkForumSee: () => ({allowed:true}), checkPost: () => ({allowed:true})} as unknown as ForumAuthorityGraph;
  const admission = createRoomChatAdmission({graph, readerKey: () => pair.pub, clock: () => 100});
  return {pair, admission};
}
test("substituted immutable pages recover real signed rows across more than 8192 invalid arrivals", async () => {
  const {pair, admission} = await fixture();
  const valid = await Promise.all(["before", "within", "after"].map(body => admission.compose("room", body, () => pair)));
  const rows = Array.from({length: 8200}, () => ({key:"invalid", value:null}));
  for (const [index, position] of [0, 4100, 8199].entries()) {
    const row = valid[index]!; rows[position] = {key:encodeKey(row.id), value:row as never};
  }
  const seen: string[] = [], binding = {};
  let active = 0, maximum = 0, pages = 0;
  const replay = createRoomChatReplay({room:"room", binding:() => binding,
    admission:{...admission, receive: async (...args) => {
      maximum = Math.max(maximum, ++active);
      try { return await admission.receive(...args); } finally { active--; }
    }}, receive: row => {seen.push(row.body);},
    source: async request => {
      pages++; assert.equal(request.limit, ROOM_REPLAY_PAGE_ROWS);
      assert.equal(request.snapshot, request.offset === 0 ? null : "snapshot");
      return JSON.stringify({snapshot:"snapshot", offset:request.offset,
        rows:rows.slice(request.offset, request.offset + request.limit), done:request.offset + request.limit >= rows.length});
    }});
  assert.equal(replay.start(), replay.start());
  assert.equal(await replay.start(), "complete");
  assert.deepEqual(seen, ["before", "within", "after"]); assert.equal(maximum, 1); assert.ok(pages > 256);
});
test("replacement during pending admission suppresses display and aborts further reads", async () => {
  const {pair, admission} = await fixture(); const row = await admission.compose("room", "hello", () => pair);
  let binding = {}, reads = 0, seen = 0;
  const replay = createRoomChatReplay({room:"room", binding:() => binding,
    admission:{...admission, receive:async (...args) => {const result = await admission.receive(...args); binding = {}; return result;}},
    receive:() => {seen++;}, source:async () => {reads++; return JSON.stringify({snapshot:"s", offset:0,
      rows:[{key:encodeKey(row!.id), value:row}], done:false});}});
  assert.equal(await replay.start(), "cancelled"); assert.equal(reads, 1); assert.equal(seen, 0);
});
test("bad offsets, snapshot replacement, empty nonfinal and oversized pages fail closed", async () => {
  const {admission} = await fixture(); const binding = {};
  for (const bad of [JSON.stringify({snapshot:"s", offset:1, rows:[], done:true}),
    JSON.stringify({snapshot:"s", offset:0, rows:[], done:false}), "x".repeat(512 * 1024 + 1)]) {
    const replay = createRoomChatReplay({room:"room", binding:() => binding, admission,
      receive:() => assert.fail(), source:async () => bad});
    await assert.rejects(replay.start());
  }
  let reads = 0;
  const replay = createRoomChatReplay({room:"room", binding:() => binding, admission, receive:() => assert.fail(),
    source:async ({offset}) => JSON.stringify({snapshot:++reads === 1 ? "first" : "changed", offset,
      rows:[{key:"bad", value:null}], done:false})});
  await assert.rejects(replay.start(), /cursor/);
});
test("close aborts a pending source and late pages cannot admit", async () => {
  const {admission} = await fixture(); const binding = {};
  let resolve!: (page:string) => void, signal:AbortSignal | undefined;
  const replay = createRoomChatReplay({room:"room", binding:() => binding, admission, receive:() => assert.fail(),
    source:request => {signal = request.signal; return new Promise(r => {resolve = r;});}});
  const result = replay.start(); replay.close(); assert.equal(signal?.aborted, true);
  resolve("malformed"); assert.equal(await result, "cancelled");
});
