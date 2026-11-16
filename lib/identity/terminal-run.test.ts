import test from "node:test";
import assert from "node:assert/strict";
import { terminalTokenClaims, verifyTerminalToken, withTerminalRun, type TerminalRunAuthority } from "./terminal-run";
const request = {} as Request; // No HTTP transport; the adapter is a named substitution.
const token = { kind: "test-session", subject: "fixture" };
function fixture(run = "1-1-suite") {
  const state = { active: true, permitted: true, completed: 0, admissions: 0, unrelated: false, available: true };
  const authority: TerminalRunAuthority = {
    async admit() { state.admissions++; return state.unrelated ? null : { binding: { run, generation: "a".repeat(64) }, operation: "12345678-1234-1234-1234-123456789abc" }; },
    async active() { if (!state.available) throw Error("offline"); return state.active; },
    async authorizeToken(_admission, input) { return state.permitted && input.subject === token.subject; },
    async complete() { state.completed++; },
  };
  const invoke = <T>(work: () => Promise<T>, completed: (result: T) => boolean = () => true) => withTerminalRun(request, authority, work, completed);
  return { state, authority, invoke };
}
test("admitted token binds original run and completes only explicit successful work", async () => {
  const h = fixture();
  const claims = await h.invoke(async () => { const claims = await terminalTokenClaims(token); await verifyTerminalToken(claims, token); return claims; });
  assert.deepEqual(claims, { nightly_run: { run: "1-1-suite", generation: "a".repeat(64) } });
  assert.equal(h.state.completed, 1);
  await assert.rejects(verifyTerminalToken(claims, token));
  await h.invoke(async () => false, result => result);
  assert.equal(h.state.completed, 1);
});
test("seal racing accepted work drains only confirmed completion and denies its result", async () => {
  const h = fixture();
  await assert.rejects(h.invoke(async () => { await terminalTokenClaims(token); h.state.active = false; return true; }));
  assert.equal(h.state.completed, 1);
  await assert.rejects(h.invoke(async () => { assert.fail("sealed native dispatch"); }));
  assert.equal(h.state.completed, 1);
});
test("lost outcome, failed completion and unknown state retain pending work", async () => {
  const h = fixture();
  await assert.rejects(h.invoke(async () => { throw Error("lost native response"); }));
  assert.equal(h.state.completed, 0);
  h.state.available = false;
  await assert.rejects(h.invoke(async () => assert.fail("unknown state")));
  h.state.available = true;
  h.authority.complete = async () => { throw Error("lost acknowledgement"); };
  await assert.rejects(h.invoke(async () => true));
});
test("fixture credentials cannot substitute an old, foreign, malformed or missing binding", async () => {
  const h = fixture();
  for (const claim of [undefined, null, {}, { run: "foreign", generation: "a".repeat(64) },
    { run: "1-1-suite", generation: "b".repeat(64) }, { run: "1-1-suite", generation: "a".repeat(64), extra: 1 }]) {
    await assert.rejects(h.invoke(() => verifyTerminalToken(claim === undefined ? {} : { nightly_run: claim }, token)));
  }
  h.state.permitted = false;
  await assert.rejects(h.invoke(() => terminalTokenClaims(token)));
  assert.equal(h.state.completed, 0);
});
test("unrelated traffic stays unchanged but never accepts bound credentials", async () => {
  const h = fixture(); h.state.unrelated = true;
  assert.deepEqual(await h.invoke(() => terminalTokenClaims(token)), {});
  await h.invoke(() => verifyTerminalToken({}, token));
  await assert.rejects(h.invoke(() => verifyTerminalToken({ nightly_run: { run: "1-1-suite", generation: "a".repeat(64) } }, token)));
  assert.equal(h.state.completed, 0);
  assert.deepEqual(await terminalTokenClaims(token), {});
});
test("concurrent requests remain isolated and detached continuations cannot mint after completion", async () => {
  const a = fixture("a"), b = fixture("b");
  const results = await Promise.all([a.invoke(() => terminalTokenClaims(token)), b.invoke(() => terminalTokenClaims(token))]);
  assert.notDeepEqual(results[0], results[1]);
  let release!: () => void;
  const pause = new Promise<void>(resolve => { release = resolve; });
  let late!: Promise<unknown>;
  await a.invoke(async () => { late = pause.then(() => terminalTokenClaims(token)); return true; });
  release(); await assert.rejects(late);
  await assert.rejects(a.invoke(() => b.invoke(async () => true)));
});
test("admission and identity checks refuse corrupt or changing owner responses", async () => {
  const h = fixture();
  h.authority.admit = async () => ({ binding: { run: "bad scope!", generation: "a".repeat(64) }, operation: "invalid" });
  await assert.rejects(h.invoke(async () => assert.fail()));
  h.authority.admit = async () => ({ binding: { run: "valid", generation: "a".repeat(64) }, operation: "invalid" });
  await assert.rejects(h.invoke(async () => assert.fail()));
  const racing = fixture();
  racing.authority.authorizeToken = async () => { racing.state.active = false; return true; };
  await assert.rejects(racing.invoke(() => terminalTokenClaims(token)));
  assert.equal(racing.state.completed, 0);
});
