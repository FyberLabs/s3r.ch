// Native SEA signing, HTTP handlers and registry/replay transport substitutions: CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createTerminalSeaRoute } from "./terminal-sea-route";
import { createSeaSessionClient } from "./sea-session-client";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const origin = "https://test.s3r.ch", tenant = "22222222-2222-2222-2222-222222222222";
const env = { S3RCH_SESSION_SIGNING_KEY: "s".repeat(40), S3RCH_IDENTITY_REPLAY_BACKEND: "spanopticon",
  S3RCH_IDENTITY_REPLAY_ORIGIN: "https://api.test.hyperme.sh", S3RCH_IDENTITY_REPLAY_TENANT_ID: tenant, S3RCH_SERVICE_CREDENTIAL: "dedicated-replay" };
test("native browser client exchanges admitted challenges through site and Squad aliases", async () => {
  for (const path of ["/api/identity/sea"]) {
    const pair = await sea.pair(), scope = { suite: "flags-s3rch-browser", subject: "11111111-1111-1111-1111-111111111111", tenant, organization: "", realm: "controlplane",
      issuer: "https://auth.test.hyperme.sh/realms/controlplane", clients: ["s3rch-web"], origins: [origin], identities: { sea: [pair.pub] } };
    const state = { run: "1-1-flags-s3rch-browser", active: true, completed: 0, replays: 0, loseReplay: false };
    const cookies = new Map<string, string>([["__Host-nightly-run-grant", "b".repeat(64)]]), used = new Set<string>();
    const route = createTerminalSeaRoute({ serviceKey: "a".repeat(64), scope, env }, async (url, init) => {
      if (String(url).includes("/storage/replays/")) {
        state.replays++; assert.equal(new Headers(init?.headers).get("X-Tenant-ID"), tenant);
        const duplicate = used.has(String(url)); used.add(String(url));
        if (state.loseReplay) throw Error("lost replay acknowledgement");
        return new Response(null, { status: duplicate ? 409 : 204 });
      }
      assert.equal(url, "https://api.test.hyperme.sh/auth/nightly-run/v1/command");
      const command = JSON.parse(String(init?.body)), base = { version: 1, owner: "s3rch", run: state.run, generation: "c".repeat(64) }, operation = "12345678-1234-1234-1234-123456789abc";
      if (command.action === "admit") return Response.json({ ...base, scope, operation });
      if (command.action === "complete") { state.completed++; return Response.json({ ...base, operation, completed: true }); }
      return Response.json({ ...base, active: state.active });
    });
    const transport: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers); headers.set("origin", origin); headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      const response = await route(new Request(origin + String(url), { ...init, headers }));
      for (const value of response.headers.getSetCookie()) { const [k, v] = value.split(";")[0].split("="); if (v) cookies.set(k, v); else cookies.delete(k); }
      return response;
    };
    const client = createSeaSessionClient({ base: path, origin, fetch: transport });
    assert.equal(await client.signIn(pair), true); assert.equal(state.replays, 1);
    assert.equal((await (await transport("/api/identity/sea/session")).json()).principal, pair.pub);
    state.run = "2-1-flags-s3rch-browser";
    assert.equal((await (await transport("/api/identity/sea/session")).json()).principal, null);
    state.active = false; assert.equal(await client.signIn(pair), false); assert.equal(state.replays, 1);
    state.active = true; state.loseReplay = true; const before = state.completed;
    assert.equal(await client.signIn(pair), false); assert.equal(state.completed, before + 1); // Only the challenge, never the uncertain exchange.
    assert.equal((await transport(path + "/linked-challenge", { method: "POST" })).status, 503);
    assert.equal(await client.logout(), true);
  }
});
