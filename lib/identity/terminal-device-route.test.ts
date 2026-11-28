// Native HTTP/HMAC/encrypted-cookie contracts run in CI only. Registry transport is substituted.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createTerminalDeviceRoute } from "./terminal-device-route";
const origin = "https://test.s3r.ch", issuer = "https://auth.test.hyperme.sh/realms/controlplane";
const scope = { suite: "s3rch-device-transfer", subject: "11111111-1111-1111-1111-111111111111", tenant: "22222222-2222-2222-2222-222222222222", organization: "", realm: "controlplane", issuer, clients: ["s3rch-web"], origins: [origin], identities: { sea: [] } };
const deviceScope = { sourceOrigin: origin, destinationOrigin: origin, application: "s3r.ch", tenant: scope.tenant, audience: "device" };
const env = { S3RCH_SESSION_SIGNING_KEY: "s".repeat(40), S3RCH_OAUTH_ISSUER: issuer, S3RCH_OAUTH_CLIENT_ID: "s3rch-web",
  S3RCH_DEVICE_TRANSFER_CONFIG: JSON.stringify({ v: 1, scope: deviceScope, auth: "https://api.test.hyperme.sh/auth/sea-device-link/v1/", acl: "https://api.test.hyperme.sh/api/v1/acl/sociacl/device-transfer/", provider: "panopticon" }) };
const key = "a".repeat(64), grant = "b".repeat(64), operation = "12345678-1234-1234-1234-123456789abc";
const base = { version: 1, owner: "s3rch", run: "1-1-s3rch-device-transfer", generation: "c".repeat(64) };
function fixture() {
  const commands: string[] = [], state = { active: true, sealOnComplete: false, lostComplete: false };
  const route = createTerminalDeviceRoute({ serviceKey: key, scope, env }, async (url, init) => {
    assert.equal(url, "https://api.test.hyperme.sh/auth/nightly-run/v1/command");
    const raw = String(init?.body), value = JSON.parse(raw); commands.push(value.action);
    assert.equal(new Headers(init?.headers).get("X-Nightly-Owner-Signature"), createHmac("sha256", Buffer.from(key, "hex")).update(raw).digest("hex"));
    if (value.action === "admit") { assert.equal(value.grant, grant); return Response.json({ ...base, scope, operation }); }
    if (value.action === "complete") { if (state.lostComplete) throw Error("lost completion"); if (state.sealOnComplete) state.active = false; return Response.json({ ...base, operation, completed: true }); }
    return Response.json({ ...base, active: state.active });
  });
  return { route, commands, state };
}
function request(action: string, proxy = false, cookie = "__Host-nightly-run-grant=" + grant) {
  return new Request((proxy ? "http://localhost:3000" : origin) + "/api/identity/device/" + action,
    { headers: { cookie, ...(proxy ? { host: "test.s3r.ch", "x-forwarded-proto": "https" } : {}) } });
}
test("native authorization admits and completes through direct and normalized TLS ingress", async () => {
  for (const proxy of [false, true]) {
    const h = fixture(), response = await h.route(request("authorize", proxy));
    assert.equal(response.status, 302); assert.ok(response.headers.getSetCookie().some(value => value.startsWith("__Host-s3rch-device-pkce=") && !value.includes("Max-Age=0")));
    assert.equal(h.commands[0], "admit"); assert.equal(h.commands.filter(value => value === "complete").length, 1);
    assert.equal(h.commands.at(-1), "verify");
  }
});
test("missing grants, foreign ingress and unlisted routes never reach registry or handler", async () => {
  for (const req of [request("authorize", false, ""), request("other"),
    new Request(origin + "/api/identity/device/authorize", { headers: { host: "attacker.invalid" } }),
    new Request(origin + "/api/identity/device/relay", { method: "POST", headers: { origin: "https://attacker.invalid" } })]) {
    const h = fixture(); assert.equal((await h.route(req)).status, 503); assert.deepEqual(h.commands, []);
  }
});
test("failed callback and refused native calls never acknowledge pending admission", async () => {
  const h = fixture(), response = await h.route(request("callback"));
  assert.equal(response.status, 302); assert.equal(response.headers.get("location"), "/identity/devices?authorization=unavailable");
  assert.ok(!h.commands.includes("complete"));
});
test("seal and unknown completion withhold signed native response", async () => {
  for (const mode of ["sealOnComplete", "lostComplete"] as const) {
    const h = fixture(); h.state[mode] = true;
    const response = await h.route(request("authorize"));
    assert.equal(response.status, 503); assert.equal(response.headers.getSetCookie().length, 0);
  }
});
test("scope and native service configuration cannot disagree", () => {
  for (const candidate of [{ ...scope, tenant: scope.subject }, { ...scope, suite: "flags-s3rch-browser" }, { ...scope, clients: ["other"] }])
    assert.throws(() => createTerminalDeviceRoute({ serviceKey: key, scope: candidate, env }));
  assert.throws(() => createTerminalDeviceRoute({ serviceKey: "bad", scope, env }));
});
test("native config and logout complete while unauthorized relay retains pending work", async () => {
  const config = fixture(); assert.equal((await config.route(request("config"))).status, 200); assert.ok(config.commands.includes("complete"));
  for (const action of ["logout", "relay"]) {
    const h = fixture(), req = new Request(origin + "/api/identity/device/" + action, { method: "POST",
      headers: { origin, cookie: "__Host-nightly-run-grant=" + grant, "content-type": "application/json" }, body: "{}" });
    const response = await h.route(req);
    assert.equal(response.status, action === "logout" ? 200 : 401);
    assert.equal(h.commands.includes("complete"), action === "logout");
  }
});
