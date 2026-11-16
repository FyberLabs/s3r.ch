// Actual HTTP/HMAC contracts, CI only. Auth transport is the named substitute;
// Auth independently owns PostgreSQL phase, fence and pending-operation tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createTerminalOwnerControl } from "./terminal-owner-control";
const pub = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.sBy9HAHlgGVxGBS1g_Bh6dQxzKmUzqExNEm_l8hArgo";
const scope = { suite: "flags-s3rch-browser", subject: "11111111-1111-1111-1111-111111111111", tenant: "22222222-2222-2222-2222-222222222222", organization: "", realm: "controlplane",
  issuer: "https://auth.test.hyperme.sh/realms/controlplane", clients: ["s3rch"], origins: ["https://test.s3r.ch"], identities: { sea: [] as string[] } };
const device = { ...scope, suite: "s3rch-device-transfer", identities: { sea: [pub] } };
const config = { version: 1, owner: "s3rch", origin: "https://test.s3r.ch", authOrigin: "https://api.test.hyperme.sh",
  controllerKey: "c".repeat(64), ownerKey: "d".repeat(64), scopes: { "flags-s3rch-browser": scope, "s3rch-device-transfer": device } };
const base = { version: 1, owner: "s3rch", run: "1-1-flags-s3rch-browser", generation: "e".repeat(64) };
const command = (action = "register") => ({ ...base, action, fence: 1, ...(action === "register" ? { grant: "a".repeat(64), scope } : {}) });
function request(value: unknown = command(), change: { raw?: string; key?: string; path?: string; method?: string; headers?: Record<string, string> } = {}) {
  const raw = change.raw ?? JSON.stringify(value);
  return new Request(change.path ?? config.origin + "/api/internal/nightly-run", { method: change.method ?? "POST",
    headers: { "Content-Type": "application/json", "X-Nightly-Controller-Signature": createHmac("sha256", Buffer.from(change.key ?? config.controllerKey, "hex")).update(raw).digest("hex"), ...change.headers },
    ...((change.method ?? "POST") === "GET" ? {} : { body: raw }) });
}
const receipt = (phase = "active") => ({ ...base, phase, terminal_verified: phase === "terminal" });
test("controller authenticates exact bytes, separates keys and validates native lifecycle receipts", async () => {
  for (const action of ["register", "status", "seal", "retire"]) {
    let calls = 0;
    const raw = JSON.stringify(command(action), null, 2), phase = action === "retire" ? "terminal" : action === "seal" ? "sealed" : "active";
    const route = createTerminalOwnerControl(JSON.stringify(config), async (url, init) => {
      calls++; assert.equal(url, config.authOrigin + "/auth/nightly-run/v1/command");
      assert.equal(init?.body, raw); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit"); assert.equal(init?.cache, "no-store");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-Nightly-Owner-Signature"), createHmac("sha256", Buffer.from(config.ownerKey, "hex")).update(raw).digest("hex"));
      assert.equal(headers.has("X-Nightly-Controller-Signature"), false); assert.equal(headers.has("cookie"), false);
      return Response.json(receipt(phase));
    });
    const response = await route(request(null, { raw })); assert.equal(response.status, 200); assert.deepEqual(await response.json(), receipt(phase)); assert.equal(calls, 1);
  }
});
test("foreign keys, paths, owners, actions, scope and unsafe fences never reach Auth", async () => {
  let calls = 0;
  const route = createTerminalOwnerControl(JSON.stringify(config), async () => { calls++; throw Error("must not call"); });
  const malformed = [null, [], {}, { ...command(), owner: "portal" }, { ...command(), action: "admit" }, { ...command(), extra: 1 },
    { ...command(), run: "1-1-portal-device-transfer" }, { ...command(), generation: "bad" }, { ...command(), version: true },
    ...[0, -1, true, 1.5, 2 ** 53].map(fence => ({ ...command(), fence })), { ...command(), grant: "bad" },
    { ...command(), scope: { ...scope, tenant: "33333333-3333-3333-3333-333333333333" } }];
  for (const value of malformed) assert.equal((await route(request(value))).status, 409);
  const invalidRequests: Parameters<typeof request>[1][] = [{ key: config.ownerKey }, { path: "https://s3r.ch/api/internal/nightly-run" }, { path: config.origin + "/other" },
    { path: config.origin + "/api/internal/nightly-run?extra=1" }, { method: "GET" }, { headers: { "X-Nightly-Controller-Signature": "bad" } },
    { headers: { "Content-Type": "text/plain" } }, { headers: { "Content-Encoding": "gzip" } },
    { raw: " ".repeat(16385) }, { raw: '{"version":1,"version":1}' }];
  for (const change of invalidRequests) assert.equal((await route(request(command(), change))).status, 409);
  assert.equal(calls, 0);
});
test("unknown, forged and ambiguous receipts cannot become terminal proof", async () => {
  const responses = [new Response(null, { status: 409 }), Response.json({ ...receipt("terminal"), terminal_verified: false }),
    Response.json({ ...receipt("terminal"), owner: "portal" }), Response.json({ ...receipt("terminal"), generation: "f".repeat(64) }),
    Response.json({ ...receipt("terminal"), extra: true }), Response.json(receipt("active")), Response.json({ ...receipt(), phase: ["terminal"], terminal_verified: true }),
    new Response(" ".repeat(16385), { headers: { "Content-Type": "application/json" } }),
    new Response('{"version":1,"version":1}', { headers: { "Content-Type": "application/json" } }),
    new Response("{}", { headers: { "Content-Type": "text/html" } }), Object.defineProperty(Response.json(receipt("terminal")), "redirected", { value: true })];
  for (const response of responses) {
    const route = createTerminalOwnerControl(JSON.stringify(config), async () => response);
    const result = await route(request(command("retire"))); assert.equal(result.status, 409); assert.deepEqual(await result.json(), { error: "nightly-run-refused" });
  }
  const route = createTerminalOwnerControl(JSON.stringify(config), async () => { throw Error("private transport information"); });
  assert.deepEqual(await (await route(request())).json(), { error: "nightly-run-refused" });
});
test("restart and retries consult durable Auth rather than local phase or cached proof", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return Response.json(receipt("terminal")); };
  for (let i = 0; i < 2; i++) {
    const route = createTerminalOwnerControl(JSON.stringify(config), transport);
    assert.equal((await route(request(command("seal")))).status, 200);
    assert.equal((await route(request(command("status")))).status, 200);
    assert.equal((await route(request(command("register")))).status, 409);
  }
  assert.equal(calls, 6);
});
