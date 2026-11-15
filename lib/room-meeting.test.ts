import assert from "node:assert/strict";
import { test } from "node:test";
import { controlMeetingTransport, selectedMeetingPath, type MeetingTransportState } from "./room-meeting";

function report(relay = false): RTCStatsReport {
  return new Map<string, object>([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote" }],
    ["local", { type: "local-candidate", candidateType: relay ? "relay" : "host" }],
    ["remote", { type: "remote-candidate", candidateType: "srflx" }],
  ]) as RTCStatsReport;
}

test("only selected, successful pairs establish a direct or relayed path", () => {
  assert.equal(selectedMeetingPath(report()), "direct");
  assert.equal(selectedMeetingPath(report(true)), "relayed");
  const stats = report(true) as Map<string, unknown>;
  stats.delete("transport");
  assert.equal(selectedMeetingPath(stats as RTCStatsReport), "unknown");
  assert.equal(selectedMeetingPath(new Map() as RTCStatsReport), "unknown");
});

test("missing candidates and unselected or failed pairs never imply direct connectivity", () => {
  const stats = report() as Map<string, unknown>;
  stats.delete("remote");
  assert.equal(selectedMeetingPath(stats as RTCStatsReport), "unknown");
  stats.set("pair", { type: "candidate-pair", state: "failed" });
  assert.equal(selectedMeetingPath(stats as RTCStatsReport), "unknown");
});

function fixture() {
  const target = new EventTarget();
  let stopped = 0;
  let closed = 0;
  let authorized = true;
  let revoke = () => {};
  let clock = 100;
  const states: MeetingTransportState[] = [];
  const peer = Object.assign(target, {
    connectionState: "new" as RTCPeerConnectionState,
    getStats: async () => report(),
    close: () => { closed++; peer.connectionState = "closed"; },
  });
  const controller = controlMeetingTransport({
    peer: peer as unknown as RTCPeerConnection,
    tracks: [{ stop: () => { stopped++; } } as unknown as MediaStreamTrack],
    authority: { current: () => authorized, expiresAt: 500,
      subscribe: (callback) => { revoke = callback; return () => {}; } },
    now: () => clock,
    changed: (state) => states.push(state),
  });
  return { peer, controller, states, revoke: () => revoke(),
    deny: () => { authorized = false; }, expire: () => { clock = 500; }, rollback: () => { clock = 99; },
    counts: () => ({ stopped, closed }) };
}

test("new and connecting peers do not report connected; revocation tears down media once", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.states.at(-1), { connection: "new", path: "unknown" });
    f.peer.connectionState = "connected";
    await f.controller.refresh();
    assert.deepEqual(f.states.at(-1), { connection: "connected", path: "direct" });
    f.revoke();
    f.controller.close();
    assert.deepEqual(f.counts(), { stopped: 1, closed: 1 });
  } finally { f.controller.close(); }
});

test("late stats cannot restore a revoked connection", async () => {
  const f = fixture();
  try {
    let resolve!: (stats: RTCStatsReport) => void;
    f.peer.getStats = () => new Promise((done) => { resolve = done; });
    f.peer.connectionState = "connected";
    const pending = f.controller.refresh();
    f.revoke();
    resolve(report(true));
    await pending;
    assert.deepEqual(f.states.at(-1), { connection: "closed", path: "unknown" });
  } finally { f.controller.close(); }
});

test("authority is checked again after stats and expires without extending permission", async () => {
  for (const action of ["deny", "expire", "rollback"] as const) {
    const f = fixture();
    try {
      f.peer.connectionState = "connected";
      f.peer.getStats = async () => { f[action](); return report(); };
      await f.controller.refresh();
      assert.deepEqual(f.states.at(-1), { connection: "closed", path: "unknown" });
      assert.deepEqual(f.counts(), { stopped: 1, closed: 1 });
    } finally { f.controller.close(); }
  }
});

test("synchronous revocation unsubscribes and stops capture even if cleanup throws", () => {
  let stopped = 0;
  let unsubscribed = 0;
  const peer = Object.assign(new EventTarget(), { close: () => { throw new Error("closed"); } });
  const states: MeetingTransportState[] = [];
  const controller = controlMeetingTransport({
    peer: peer as unknown as RTCPeerConnection,
    tracks: [{ stop: () => { stopped++; } } as unknown as MediaStreamTrack],
    authority: { current: () => true, expiresAt: 500, subscribe: (revoke) => {
      revoke();
      return () => { unsubscribed++; };
    } },
    now: () => 100,
    changed: (state) => states.push(state),
  });
  controller.close();
  assert.equal(stopped, 1);
  assert.equal(unsubscribed, 1);
  assert.deepEqual(states, [{ connection: "closed", path: "unknown" }]);
});
