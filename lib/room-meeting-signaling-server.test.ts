import assert from "node:assert/strict";
import test from "node:test";
import { seaSessionCookieNames } from "./identity/sea-session-http";
import vectors from "./identity/vectors/forums.json";
import { createRoomMeetingSignaling } from "./room-meeting-signaling-server";
import type { MeetingLease } from "./meeting-signaling-contract";

const origin = "https://test.s3r.ch";
const room = "room_p_" + "a".repeat(128) + "_" + "b".repeat(32);
const otherRoom = "room_p_" + "a".repeat(128) + "_" + "c".repeat(32);
const first = vectors.seaPubkey;
const second = vectors.secondPubkey;

function fixture() {
  const allowed = new Set([first, second]);
  const sessions = new Map([["first", first], ["second", second], ["replacement", second]]);
  let time = 1000;
  const route = createRoomMeetingSignaling({
    origin, tenant: "11111111-1111-4111-8111-111111111111",
    clock: () => time,
    async verify(token) {
      const key = sessions.get(token);
      if (!key) throw Error("Session unavailable");
      return { key, id: token, expiresAt: 60_000 };
    },
    async authority(requestedRoom) {
      return {
        current: () => true,
        principal: key => key,
        mayJoin: key => requestedRoom === room && allowed.has(key),
      };
    },
  });
  function post(token: string | null, peer: string, fields: Record<string, unknown>, from = origin) {
    const headers = new Headers({ "origin": from, "content-type": "application/json" });
    if (token) headers.set("cookie", seaSessionCookieNames()[0] + "=" + token);
    return route(new Request(origin + "/api/squad/pilot/meeting", {
      method: "POST", headers, body: JSON.stringify({ room, peer, ...fields }),
    }));
  }
  async function connect(): Promise<MeetingLease> {
    const waiting = await post("first", second, { operation: "admit" });
    assert.equal(waiting.status, 200);
    assert.equal((await waiting.json()).state, "waiting");
    const response = await post("second", first, { operation: "admit" });
    assert.equal(response.status, 200);
    const { lease, state } = await response.json();
    assert.equal(state, "ready");
    assert.equal(lease.offerer, first);
    assert.deepEqual(await (await post("first", second, { operation: "admit" })).json(), { state, lease });
    return lease;
  }
  return { allowed, sessions, post, connect, advance: (amount: number) => { time += amount; } };
}
function offer(lease: MeetingLease) {
  const sender = lease.participants[0];
  return {
    v: 1, tenant: lease.tenant, room: lease.room, meeting: lease.meeting, generation: lease.generation,
    from: first, to: second, key: sender.key, session: sender.session, seq: 1,
    kind: "offer", body: "v=0\r\n",
  };
}

test("signaling requires two authenticated room members and the site origin", async () => {
  const f = fixture();
  assert.equal((await f.post(null, second, { operation: "admit" })).status, 401);
  assert.equal((await f.post("first", second, { operation: "admit" }, "https://outside.invalid")).status, 403);
  assert.equal((await f.post("first", second, { operation: "admit", room: otherRoom })).status, 403);
  await f.connect();
});

test("frames remain private to the bound recipient and reads acknowledge only delivered frames", async () => {
  const f = fixture();
  const lease = await f.connect();
  const frame = offer(lease);
  const send = (value: unknown) => f.post("first", second, { operation: "send", frame: value });
  const read = (after: number) => f.post("second", first, { operation: "read", after, generation: lease.generation });
  assert.equal((await send({ ...frame, room: otherRoom })).status, 409);
  assert.equal((await send(frame)).status, 200);
  assert.deepEqual(await (await send(frame)).json(), { generation: lease.generation, sequence: 1 });
  assert.equal((await send({ ...frame, body: "different" })).status, 409);
  assert.equal((await read(1)).status, 409);
  assert.deepEqual(await (await read(0)).json(), { generation: lease.generation, frames: [frame] });
  assert.deepEqual(await (await read(1)).json(), { generation: lease.generation, frames: [] });
});

test("current grant withdrawal, proof withdrawal and session replacement close the old lease", async () => {
  for (const event of ["grant", "proof", "replacement", "expiry"]) {
    const f = fixture();
    const lease = await f.connect();
    if (event === "grant") f.allowed.delete(second);
    if (event === "proof") f.sessions.delete("second");
    if (event === "expiry") f.advance(30_000);
    if (event === "replacement") assert.equal((await f.post("replacement", first, { operation: "admit" })).status, 409);
    const response = await f.post("first", second, { operation: "send", frame: offer(lease) });
    assert.ok([403, 409].includes(response.status));
    const body = await response.json();
    assert.deepEqual(body, { error: "meeting-signaling-unavailable" });
  }
});
