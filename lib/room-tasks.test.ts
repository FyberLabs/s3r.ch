import { chatRow, roomSourceRef } from "./views-adapters";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { canUseRoomTasks, visibleRoomTaskChat, roomTaskPublicationIds, composeRoomTask, parseTaskAction, roomTaskChatText, roomTasks, type TaskAction } from "./room-tasks";
import { preparePublishRoomChat, type ChatMessage } from "./chat";
import { applySeeGrant, roomSoul } from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";
import { composeRoom } from "./rooms";
const owner = "PtETt4g7TFkGODedsMIc2hZ0LtAlUEi_QzOR03S8IdE.kJkgmszEyKIkyEOvpPTGigkNBNpemIna4vju_OgqN0A", other = "dB3VvagX2V5GJlNzIOXVUXmYMCiy-CyZ1QDF7oYk48Q.B3C0apw4X9xWc4NVSIexVI7rkSw1ulynGZX_Is1EgdM";
const room = composeRoom({ title: "Work room", address: owner, nowSeconds: 100, entropy: "work" })!.id;
function event(action: TaskAction, author = owner, at = 100): ChatMessage {
  const row = composeRoomTask(room, author, action, at); assert.ok(row); return row;
}
test("tasks and issues replay creation, status, assignment and removal on the room chat path", () => {
  const create = event(["create", "task", "Prepare the release", "mine", "open", null]), id = create.id;
  const doing = event(["status", id, id, "doing"]);
  const assigned = event(["assign", id, doing.id, other]);
  const done = event(["status", id, assigned.id, "done"]);
  const clear = event(["assign", id, done.id, null]);
  const rows = [create, doing, assigned, done, clear], task = roomTasks(rows, room)[0];
  assert.equal(task.status, "done"); assert.equal(task.assignee, null); assert.equal(task.head, clear.id);
  assert.equal(roomTasks([create, doing, assigned], room)[0].assignee, other);
  assert.deepEqual(task.events.map(e => e.name), ["room.object.created", ...Array(4).fill("room.object.updated")]);
  assert.deepEqual(roomTasks(JSON.parse(JSON.stringify(rows)).reverse(), room)[0], task);
  assert.ok(Object.isFrozen(task)); assert.ok(Object.isFrozen(task.events));
  assert.equal(roomTasks([event(["create", "issue", "Fix the link", "mine", "open", null])], room)[0].kind, "issue");
});
test("only the creator changes state; assignment confers no authority", () => {
  const create = event(["create", "task", "Review", "mine", "open", null]), id = create.id;
  const assigned = event(["assign", id, id, other]);
  const outsider = event(["status", id, assigned.id, "done"], other);
  const task = roomTasks([create, assigned, outsider], room)[0];
  assert.equal(task.status, "open"); assert.equal(task.head, assigned.id);
  const old = event(["status", id, assigned.id, "done"], owner, 99);
  assert.equal(roomTasks([create, assigned, old], room)[0].head, assigned.id);
});
test("missing parents wait and concurrent siblings converge independently of arrival", () => {
  const create = event(["create", "task", "Review", "mine", "open", null]), id = create.id;
  const a = event(["status", id, id, "doing"]), b = event(["status", id, id, "done"]);
  const winner = a.id < b.id ? a : b;
  const next = event(["assign", id, winner.id, other]);
  assert.equal(roomTasks([create, next], room)[0].head, id);
  const result = roomTasks([create, a, b, next], room);
  assert.equal(result[0].head, next.id);
  assert.deepEqual(roomTasks([next, b, create, a], room), result);
  const loser = winner === a ? b : a;
  assert.deepEqual(roomTasks([create, a, b, next, event(["assign", id, loser.id, owner])], room), result);
});
test("room boundaries, malformed records and duplicate conflicts cannot forge task state", () => {
  const create = event(["create", "task", "Review", "mine", "open", null]);
  for (const altered of [{ ...create, room: "elsewhere" }, { ...create, author: other }, { ...create, author: "bad" },
    { ...create, v: 99 }, { ...create, ts: NaN }, { ...create, ts: 101 }, { ...create, id: "bad" }]) {
    assert.deepEqual(roomTasks([altered], room), []);
  }
  const conflict = { ...create, body: 's3rch-work:v1:["create","task","Other title","mine","open",null]' };
  assert.deepEqual(roomTasks([create, conflict], room), []);
  assert.deepEqual(roomTasks([create, create], room), roomTasks([create], room));
  assert.deepEqual(roomTasks(new Array(8193).fill(create), room), []);
  assert.equal(roomTasks(Array.from({ length: 65 }, (_, i) => event(["create", "task", String(i), "mine", "open", null], owner, 100 + i)), room).length, 64);
});
test("bounded actions reject unknown versions, bad titles, invalid fields and oversized updates", () => {
  for (const body of [null, {}, "s3rch-work:v2:[]", "s3rch-work:v1:{", "s3rch-work:v1:{}", "x".repeat(281),
    's3rch-work:v1:["create","task",""]', 's3rch-work:v1:["create","task"," leading"]',
    's3rch-work:v1:["create","task","line\\nbreak"]', 's3rch-work:v1:["create","unknown","title"]']) assert.equal(parseTaskAction(body), null);
  const create = event(["create", "task", "Review", "mine", "open", null]), id = create.id;
  for (const action of [["create", "task", "x".repeat(81), "mine", "open", null], ["status", id, id, "bad"], ["assign", id, id, "bad"],
    ["assign", id, id, 12], ["status", "bad", id, "open"], ["create", "task", "ok", "extra"]]) {
    assert.equal(composeRoomTask(room, owner, action as unknown as TaskAction), null);
  }
  assert.equal(composeRoomTask(room, "bad", ["create", "task", "Title", "mine", "open", null]), null);
  assert.match(roomTaskChatText(create.body), /Created task: Review/);
  assert.match(roomTaskChatText(event(["status", id, id, "doing"]).body), /doing/);
  assert.match(roomTaskChatText(event(["assign", id, id, other]).body), /Assigned/);
  assert.match(roomTaskChatText(event(["assign", id, id, null]).body), /Cleared/);
  assert.equal(roomTaskChatText("ordinary chat"), "ordinary chat");
});
test("room Check gates work and Mine-only events stay off the shared graph", () => {
  const acl = createMemorySeeAcl(), create = event(["create", "task", "Private work", "mine", "open", null]);
  assert.equal(canUseRoomTasks(acl, room, owner, 100), false);
  acl.putObject(roomSoul(room), owner);
  assert.equal(canUseRoomTasks(acl, room, owner, 100), true);
  assert.equal(canUseRoomTasks(acl, room, other, 100), false);
  applySeeGrant(acl, owner, { claimId: roomSoul(room), accessor: other, from: 100, until: 200 });
  assert.equal(canUseRoomTasks(acl, room, other, 150), true);
  assert.equal(canUseRoomTasks(acl, room, other, 200), false);
  assert.ok("denied" in preparePublishRoomChat(acl, create, owner, []));
  assert.ok(!("denied" in preparePublishRoomChat(acl, create, owner, [room])));
});


test("sharing a copy carries only the current state and begins a separate history", () => {
  const privateTask = event(["create", "issue", "Private review", "mine", "open", null]);
  const assigned = event(["assign", privateTask.id, privateTask.id, other]);
  const view = roomTasks([privateTask, assigned], room)[0];
  const shared = event(["create", view.kind, view.title, "room", view.status, view.assignee]);
  const copy = roomTasks([shared], room)[0];
  assert.equal(copy.visibility, "room"); assert.equal(copy.assignee, other);
  assert.notEqual(copy.id, view.id); assert.equal(copy.events.length, 1);
  assert.ok(!shared.body.includes(privateTask.id));
  assert.equal(view.visibility, "mine");
  for (const title of ["", " leading", "line\nbreak", "x".repeat(81)]) {
    assert.equal(composeRoomTask(room, owner, ["create", "task", title, "mine", "open", null]), null);
  }
  assert.equal(composeRoomTask(room, owner, ["create", "task", "Title", "room", "open", "bad"]), null);
});


test("room-share replay and chat summaries enforce the same task privacy boundary", () => {
  const acl = createMemorySeeAcl(); acl.putObject(roomSoul(room), owner);
  const privateRow = event(["create", "task", "Private", "mine", "open", null]);
  const update = event(["status", privateRow.id, privateRow.id, "done"]);
  const publicRow = event(["create", "task", "Shared", "room", "open", other]);
  const ordinary = { ...privateRow, id: privateRow.id + "text", body: "Ordinary chat" };
  const unknown = { ...privateRow, id: privateRow.id + "future", body: "s3rch-work:v2:private" };
  const rows = [privateRow, update, publicRow, ordinary, unknown];
  assert.deepEqual([...roomTaskPublicationIds(rows, room, owner, acl, 100)], [publicRow.id]);
  assert.deepEqual([...roomTaskPublicationIds(rows, room, other, acl, 100)], []);
  assert.deepEqual(visibleRoomTaskChat(rows, room, null, acl, 100), [ordinary]);
  assert.deepEqual(visibleRoomTaskChat(rows, room, owner, null, 100), [ordinary]);
  assert.deepEqual(visibleRoomTaskChat(rows, room, owner, acl, 100), [privateRow, update, publicRow, ordinary]);
  applySeeGrant(acl, owner, { claimId: roomSoul(room), accessor: other, from: 100, until: 200 });
  assert.deepEqual(visibleRoomTaskChat(rows, room, other, acl, 150), [publicRow, ordinary]);
  assert.deepEqual(visibleRoomTaskChat(rows, room, other, acl, 200), [ordinary]);
  assert.deepEqual([...roomTaskPublicationIds(rows, room, other, acl, 150)], []);
});

// Pin the fail-closed production boundary until authenticated admission replaces it.
test("production room paths filter signatures before rendering and keep task UI disabled", () => {
  const chat = readFileSync(new URL("../components/RoomChat.tsx", import.meta.url), "utf8");
  const feed = readFileSync(new URL("../components/FeedStream.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(chat, /(?:import.*RoomTasks|<RoomTasks|visibleRoomTaskChat|roomTaskChatText)/);
  assert.match(chat, /rankChatMessages\(verified\.filter\(row => !isRoomTaskBody\(row\.body\)\)\)/);
  assert.match(feed, /if \(isRoomTaskBody\(row\.body\)\) continue;/);
  assert.match(feed, /if \(!canMutate\(\) \|\| !roomAuthority\?\.admission\.valid\(next\) \|\| isRoomTaskBody\(next\.body\)\) return;\s+setOverlayChat/);
});

test("Views room adapter quarantines forged work while preserving ordinary chat", () => {
  const ref = roomSourceRef(`s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`, { id: room, owner });
  assert.ok(ref.ok);
  const forged = event(["create", "task", "Forged", "room", "open", null]);
  for (const body of [forged.body, "s3rch-work:v2:[]", "s3rch-work:malformed"])
    assert.equal(chatRow(ref.value, { ...forged, body }), null);
  assert.equal(chatRow(ref.value, { ...forged, body: "ordinary chat" })?.body, "ordinary chat");
});
