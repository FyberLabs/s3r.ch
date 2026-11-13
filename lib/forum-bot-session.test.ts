import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createBotSession } from "./forum-bot-session";
import { createIdentitySessions } from "./identity/sea-session";
import { createSeaSessionHandlers } from "./identity/sea-session-http";
import type { SeaPair } from "./identity/sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
test("the bot establishes its own proof-bound session without borrowing browser cookies", async () => {
  const pair = await sea.pair(), origin = "https://bot.example.test";
  const issuer = createIdentitySessions({ origin, secret: "test-secret-".repeat(8), consume: async () => true });
  const handlers = createSeaSessionHandlers({ origin, sessions: issuer }); let authenticated: string | null = null;
  const session = createBotSession({ origin, pair, fetch: async (target, init) => {
    const request = new Request(String(target), init);
    assert.equal(request.headers.get("origin"), origin); assert.equal(request.headers.get("authorization"), null);
    const action = new URL(request.url).pathname.split("/").at(-1)!;
    if (action === "challenge" || action === "exchange" || action === "logout") return handlers[action](request);
    authenticated = (await handlers.authenticate(request))?.key ?? null; return Response.json({ ok: !!authenticated });
  } });
  assert.equal(await session.signIn(), true);
  assert.equal((await session.fetch("/authority", { headers: { Cookie: "stolen-owner-cookie", Authorization: "Bearer owner" } })).status, 200);
  assert.equal(authenticated, pair.pub);
  await assert.rejects(session.fetch("https://other.test/authority"), /endpoint differs/);
  await session.close(); await session.fetch("/authority"); assert.equal(authenticated, null);
});
test("foreign-domain or insecure issuer cookies are never sent onward", async () => {
  const pair = await sea.pair();
  for (const cookie of ["__Host-s3rch-squad-session=x; Path=/; HttpOnly", "__Host-s3rch-squad-session=x; Path=/; Secure; HttpOnly; Domain=other.test"] ) {
    const session = createBotSession({ origin: "https://bot.example.test", pair,
      fetch: async () => new Response("{}", { headers: { "Content-Type": "application/json", "Set-Cookie": cookie } }) });
    await assert.rejects(session.fetch("/authority"), /cookie/);
  }
});
