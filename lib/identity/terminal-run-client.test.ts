// HMAC and HTTP-response contracts are CI-only; all transport is substituted.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createTerminalHttpAuthority, parseTerminalScope } from "./terminal-run-client";
import { withTerminalRun, terminalTokenClaims } from "./terminal-run";
const scope = { suite: "flags-s3rch-browser", subject: "11111111-1111-1111-1111-111111111111", tenant: "22222222-2222-2222-2222-222222222222", organization: "", realm: "controlplane",
  issuer: "https://auth.test.hyperme.sh/realms/controlplane", clients: ["s3rch"], origins: ["https://test.s3r.ch"], identities: { sea: [] } };
const config = { serviceKey: "a".repeat(64), scopes: [scope] };
const run = "1-1-flags-s3rch-browser", generation = "b".repeat(64), operation = "12345678-1234-1234-1234-123456789abc";
const base = { version: 1, owner: "s3rch", run, generation };
const request = (cookie = "__Host-nightly-run-grant=" + "c".repeat(64), origin = "https://test.s3r.ch") => new Request(origin + "/api/experiments", { headers: { cookie } });
function fixture(change: (value: Record<string, unknown>, action: string) => unknown = value => value) {
  const commands: Record<string, unknown>[] = [];
  const authority = createTerminalHttpAuthority(config, async (url, init) => {
    assert.equal(url, "https://auth.test.hyperme.sh/auth/nightly-run/v1/command");
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "omit");
    const body = String(init?.body), headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Nightly-Owner-Signature"), createHmac("sha256", Buffer.from(config.serviceKey, "hex")).update(body).digest("hex"));
    const command = JSON.parse(body); commands.push(command);
    assert.equal(command.version, 1); assert.equal(command.owner, "s3rch");
    const result = command.action === "admit" ? { ...base, scope, operation } : command.action === "verify" ? { ...base, active: true } : { ...base, operation, completed: true };
    return Response.json(change(result, command.action));
  });
  return { authority, commands };
}
test("native registry adapter authenticates commands and independently verifies original scope", async () => {
  const h = fixture();
  const claims = await withTerminalRun(request(), h.authority, () => terminalTokenClaims({ kind: "s3rch-experiment-consent-v1", subject: null }), () => true);
  assert.deepEqual(claims, { nightly_run: { run, generation } });
  assert.equal(h.commands[0].action, "admit");
  assert.ok(h.commands.some(command => command.action === "complete"));
  assert.equal(h.commands.at(-1)?.action, "verify");
  await assert.rejects(h.authority.admit(request()));
});
test("missing duplicate and foreign-origin grants refuse before network effects", async () => {
  for (const [cookie, origin] of [["", "https://test.s3r.ch"], ["__Host-nightly-run-grant=x", "https://test.s3r.ch"],
    ["__Host-nightly-run-grant=" + "c".repeat(64) + "; __Host-nightly-run-grant=" + "c".repeat(64), "https://test.s3r.ch"],
    ["__Host-nightly-run-grant=" + "c".repeat(64), "https://s3r.ch"]]) {
    const h = fixture(); await assert.rejects(h.authority.admit(request(cookie, origin))); assert.equal(h.commands.length, 0);
  }
});
test("foreign receipts and changed configured scope never publish admission", async () => {
  for (const override of [{ owner: "portal" }, { version: 2 }, { generation: "short" }, { run: "foreign" }, { operation: "short" }, { extra: true },
    { scope: { ...scope, subject: "33333333-3333-3333-3333-333333333333" } }]) {
    await assert.rejects(fixture(value => ({ ...value, ...override })).authority.admit(request()));
  }
});
test("token identity namespaces remain distinct and unregistered credentials deny", async () => {
  const h = fixture(), admitted = await h.authority.admit(request()); assert.ok(admitted);
  assert.equal(await h.authority.authorizeToken(admitted, { kind: "provider-id-token", subject: scope.subject }), true);
  for (const token of [{ kind: "s3rch-identity-session-v1", subject: scope.subject }, { kind: "wallet-session", subject: scope.subject },
    { kind: "provider-id-token", subject: "foreign" }, { kind: "s3rch-experiment-consent-v1", subject: scope.subject }]) {
    assert.equal(await h.authority.authorizeToken(admitted, token), false);
  }
  await assert.rejects(h.authority.active({ ...admitted, operation: "87654321-1234-1234-1234-123456789abc" }));
});
test("verify and completion require exact positive receipts", async () => {
  for (const override of [{ active: false }, { owner: "portal" }, { generation: "c".repeat(64) }]) {
    const h = fixture((value, action) => action === "verify" ? { ...value, ...override } : value), admission = await h.authority.admit(request()); assert.ok(admission);
    if ("active" in override) assert.equal(await h.authority.active(admission), false); else await assert.rejects(h.authority.active(admission));
  }
  const h = fixture((value, action) => action === "complete" ? { ...value, completed: false } : value), admission = await h.authority.admit(request()); assert.ok(admission);
  await assert.rejects(h.authority.complete(admission));
});
test("transport refuses errors, redirects, oversized, duplicate and malformed bodies", async () => {
  for (const response of [new Response(null, { status: 409 }), new Response("{}", { headers: { "Content-Type": "text/html" } }),
    new Response("x".repeat(16385), { headers: { "Content-Type": "application/json" } }),
    new Response('{"version":1,"version":1}', { headers: { "Content-Type": "application/json" } }),
    Response.json({}), Object.defineProperty(Response.json({}), "redirected", { value: true })]) {
    await assert.rejects(createTerminalHttpAuthority(config, async () => response).admit(request()));
  }
  await assert.rejects(createTerminalHttpAuthority(config, async () => { throw Error("transport details"); }).admit(request()), { message: "Terminal run authority unavailable" });
});
test("deployment scope is strict and copied before use", () => {
  for (const value of [null, { ...scope, extra: true }, { ...scope, realm: "production" }, { ...scope, identities: { sea: [scope.subject] } },
    { ...scope, clients: ["same", "same"] }, { ...scope, origins: ["https://s3r.ch"] }, { ...scope, origins: ["https://test.s3r.ch.attacker.invalid"] }, { ...scope, origins: ["https://attacker.invalid/https://test.s3r.ch"] }]) assert.throws(() => parseTerminalScope(value));
  assert.throws(() => createTerminalHttpAuthority({ ...config, serviceKey: "short" }));
  assert.throws(() => createTerminalHttpAuthority({ ...config, scopes: [scope, scope] }));
  const copied = parseTerminalScope(scope); assert.notEqual(copied, scope); assert.ok(Object.isFrozen(copied.identities.sea));
});
