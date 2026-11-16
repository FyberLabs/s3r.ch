// Native SEA signing/verifier contracts: CI only. Replay storage is substituted.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createIdentitySessions } from "./sea-session";
import { createIdentityTokenVerifier } from "./sea-session-verifier";
import { signForumRecord } from "../forum-sign";
import { createTerminalFixturePolicy } from "./terminal-fixture-policy";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
test("actual issuer and verifier refuse unbound fixture credentials independently of grant presence", async () => {
  const fixture = await sea.pair(), unrelated = await sea.pair(), used = new Set<string>();
  const input = { origin: "https://test.s3r.ch", secret: "s".repeat(40), consume: async (id: string) => { if (used.has(id)) return false; used.add(id); return true; } };
  const sessions = createIdentitySessions(input), reader = createIdentityTokenVerifier(input);
  async function legacy(pair: SeaPair) { const challenge = await sessions.challenge(pair.pub); return sessions.exchange(challenge, (await signForumRecord(challenge, pair))!); }
  const old = await legacy(fixture), other = await legacy(unrelated); assert.ok(old); assert.ok(other);
  const policy = createTerminalFixturePolicy([{ suite: "flags-s3rch-browser", subject: "11111111-1111-1111-1111-111111111111", tenant: "22222222-2222-2222-2222-222222222222", organization: "", realm: "controlplane",
    issuer: "https://auth.test.hyperme.sh/realms/controlplane", clients: ["s3rch"], origins: [input.origin], identities: { sea: [fixture.pub] } }]);
  await assert.rejects(policy(() => sessions.challenge(fixture.pub)));
  assert.equal(await policy(() => reader.authenticate(old)), null);
  assert.deepEqual(await policy(() => reader.authenticate(other)), { key: unrelated.pub });
  assert.ok(await policy(() => sessions.challenge(unrelated.pub)));
});
