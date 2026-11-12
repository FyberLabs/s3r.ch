import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedGun } from "../components/GunPeerProvider";
import { createForumSubscriptions } from "./forum-subscriptions";

type Callback = (data: unknown, key?: string) => void;
function fixture(initial?: (callback: Callback) => void) {
  const calls: { path: string[]; mapped: boolean; emit: Callback; stops: number }[] = [];
  function node(path: string[] = []): FeedGun {
    const listen = (mapped: boolean, emit: Callback) => {
      const call = { path, mapped, emit, stops: 0 };
      calls.push(call);
      initial?.(emit);
      return { off() { call.stops++; } };
    };
    return {
      get: key => node([...path, key]),
      put() { throw new Error("Subscriptions must never write"); },
      on: callback => listen(false, callback),
      map: () => ({ on: callback => listen(true, callback as Callback) }),
    };
  }
  return { gun: node(), calls };
}

test("named subscriptions preserve forum scope, SEA keys, and collection semantics", () => {
  const { gun, calls } = fixture();
  const transport = createForumSubscriptions(gun, "forum.id");
  const rows: unknown[] = [];
  const receive: Callback = (data, key) => rows.push([data, key]);
  transport.agents(receive); transport.template(receive); transport.roles(receive);
  transport.roleMembers("helper", receive); transport.needs(receive); transport.alarm(receive);
  transport.items(receive); transport.itemRemoval("statement.id", receive);
  transport.needRemoval("need.id", receive); transport.offers("need.id", receive);
  transport.offerCancel("need.id", "offer.id", receive);
  transport.offerRemoval("need.id", "offer.id", receive);
  transport.agentRemoval("sea.pub", receive); transport.agentAdmission("sea.pub", receive);
  const forum = ["s3rch", "forums", "forum.id"];
  assert.deepEqual(calls.map(({ path, mapped }) => [path, mapped]), [
    [[...forum, "agents"], true], [[...forum, "template"], false],
    [[...forum, "roles"], true], [[...forum, "roles", "helper"], true],
    [[...forum, "needs"], true], [[...forum, "alarm"], false],
    [["s3rch", "items"], true], [["s3rch", "items", "statement.id", "remove"], false],
    [[...forum, "needs", "need.id", "remove"], false],
    [[...forum, "needs", "need.id", "offers"], true],
    [[...forum, "needs", "need.id", "offers", "offer.id", "cancel"], false],
    [[...forum, "needs", "need.id", "offers", "offer.id", "remove"], false],
    [[...forum, "agents", "sea.pub", "remove"], false],
    [[...forum, "agents", "sea.pub", "admission"], false],
  ]);
  const untrusted = { sig: "unverified", value: "unchanged" };
  calls[0].emit(untrusted, "sea.pub"); calls[1].emit(null); calls[2].emit(undefined);
  assert.deepEqual(rows, [[untrusted, "sea.pub"], [null, undefined], [undefined, undefined]]);
  assert.equal((rows[0] as unknown[])[0], untrusted);
  transport.close();
  assert.ok(calls.every(call => call.stops === 1));
});

test("individual removal suppresses queued notifications without stopping another listener", () => {
  const { gun, calls } = fixture();
  const transport = createForumSubscriptions(gun, "forum");
  const received: unknown[] = [];
  const first = transport.needs(data => received.push(data));
  transport.needs(data => received.push(data));
  first.off(); first.off();
  calls[0].emit("stale"); calls[1].emit("current");
  assert.deepEqual(received, ["current"]);
  transport.close(); transport.close();
  calls[1].emit("late");
  assert.deepEqual(received, ["current"]);
  assert.deepEqual(calls.map(call => call.stops), [1, 1]);
  transport.agents(() => assert.fail("closed callback")).off();
  assert.equal(calls.length, 2);
});

test("synchronous first notification may close transport before listener registration returns", () => {
  const { gun, calls } = fixture(callback => callback("initial"));
  const transport = createForumSubscriptions(gun, "forum");
  let received = 0;
  transport.agents(() => { received++; transport.close(); });
  assert.equal(calls[0].stops, 1);
  calls[0].emit("queued");
  assert.equal(received, 1);
});

test("failed registration suppresses an already captured callback", () => {
  const { gun, calls } = fixture(() => { throw new Error("registration failed"); });
  const transport = createForumSubscriptions(gun, "forum");
  assert.throws(() => transport.agents(() => assert.fail("failed callback")), /registration failed/);
  calls[0].emit("queued");
  transport.close();
});
