// Pure fixture classification and mocked admission; no signing or HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalFixturePolicy } from "./terminal-fixture-policy";
import { terminalTokenClaims, verifyTerminalToken, withTerminalRun, type TerminalRunAuthority } from "./terminal-run";
const pub = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.sBy9HAHlgGVxGBS1g_Bh6dQxzKmUzqExNEm_l8hArgo";
const scope = { suite: "flags-s3rch-browser", subject: "11111111-1111-1111-1111-111111111111", tenant: "22222222-2222-2222-2222-222222222222", organization: "", realm: "controlplane",
  issuer: "https://auth.test.hyperme.sh/realms/controlplane", clients: ["s3rch"], origins: ["https://test.s3r.ch"], identities: { sea: [pub] } };
const policy = createTerminalFixturePolicy([scope]);
test("configured fixture subjects cannot issue or replay ordinary credentials without admission", async () => {
  for (const subject of [pub, scope.subject]) for (const kind of ["s3rch-identity-session-v1", "provider-id-token", "s3rch-startup-credential-v1", "unknown-kind"]) {
    await assert.rejects(policy(() => terminalTokenClaims({ kind, subject })));
    await assert.rejects(policy(() => verifyTerminalToken({}, { kind, subject })));
  }
});
test("unrelated identities and anonymous precursors retain legacy behavior", async () => {
  for (const subject of ["unrelated", null]) {
    assert.deepEqual(await policy(() => terminalTokenClaims({ kind: "native", subject })), {});
    await policy(() => verifyTerminalToken({}, { kind: "native", subject }));
  }
  assert.deepEqual(await terminalTokenClaims({ kind: "native", subject: pub }), {}); // Factory remains uninstalled.
});
test("admitted fixture still requires original binding and native owner authorization", async () => {
  let permit = true;
  const authority: TerminalRunAuthority = {
    async admit() { return { binding: { run: "1-1-flags-s3rch-browser", generation: "a".repeat(64) }, operation: "12345678-1234-1234-1234-123456789abc" }; },
    async active() { return true; }, async authorizeToken() { return permit; }, async complete() {},
  };
  const token = { kind: "native", subject: pub };
  const invoke = <T>(work: () => Promise<T>) => policy(() => withTerminalRun({} as Request, authority, work, () => true));
  const claims = await invoke(() => terminalTokenClaims(token)); await invoke(() => verifyTerminalToken(claims, token));
  await assert.rejects(policy(() => verifyTerminalToken(claims, token)));
  await assert.rejects(invoke(() => verifyTerminalToken({}, token)));
  permit = false; await assert.rejects(invoke(() => terminalTokenClaims(token)));
});
test("policy snapshots cannot be mutated or replaced by a nested fallback", async () => {
  const source = structuredClone(scope), copied = createTerminalFixturePolicy([source]); source.identities.sea.length = 0; source.subject = "33333333-3333-3333-3333-333333333333";
  await assert.rejects(copied(() => terminalTokenClaims({ kind: "native", subject: pub })));
  await assert.rejects(policy(() => copied(async () => true)));
  for (const value of [[], [scope, scope], [scope, scope, scope], null]) assert.throws(() => createTerminalFixturePolicy(value as unknown as unknown[]));
});
test("detached policy continuations cannot issue or verify even unrelated identities after close", async () => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  let late!: Promise<unknown>, verify!: Promise<unknown>;
  await policy(async () => {
    late = pause.then(() => terminalTokenClaims({ kind: "native", subject: null }));
    verify = pause.then(() => verifyTerminalToken({}, { kind: "native", subject: "unrelated" }));
  });
  release(); await assert.rejects(late); await assert.rejects(verify);
  assert.deepEqual(await terminalTokenClaims({ kind: "native", subject: null }), {});
});
