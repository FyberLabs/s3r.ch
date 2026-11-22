import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { signForumRecord } from "./forum-sign";
import { createRoomChatAdmission, type SignedRoomChat } from "./room-chat-admission";
import { createNativeRoomBotReply } from "./native-room-bot-reply";
import { encodeKey } from "./identity/check";
import { seaToPrincipalKey } from "./identity/forum-check";
import { parseForumAuthority } from "./identity/forum-authority-records";
import vectors from "./identity/vectors/forum-authority.json";

test("native bot replies require delegation and room post rights and reach signed room chat", async t => {
  const f = await forumBotFixture(t);
  const at = f.now();
  const room = `room_${seaToPrincipalKey(f.owner.pub)}_${"b".repeat(32)}`;
  function authorityRow(kind: "object" | "see" | "post", fields: object) {
    const record = { object: room, owner: f.owner.pub, issuedAt: at, ...fields, sig: "pending" };
    const parsed = parseForumAuthority(kind, record);
    assert.ok(parsed);
    record.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(f.owner.priv, "base64url"), {
      prehash: true, format: "compact",
    })).toString("base64url");
    return { kind, soul: parsed.soul, record };
  }
  const grant = { accessor: f.a.pub, from: at, until: at + 60, hamState: at, stated: 1 };
  f.rows.push(authorityRow("object", {}), authorityRow("see", grant));
  const writer = authorityRow("post", grant);
  const published: SignedRoomChat[] = [];
  let shared = true;
  let advanceDuringLookup = false;
  const reply = createNativeRoomBotReply({
    authenticate: async request => request.headers.get("authorization") === "Bearer room-scope"
      ? { agent: f.a.pub, principal: f.owner.pub, delegationId: "fixture" } : null,
    authority: { keys: [], pinnedIssuers: [], policy: vectors.context.policy },
    parent: { id: f.forum, owner: f.owner.pub },
    clock: f.now,
    read: async now => ({
      completeThrough: now, rows: f.rows,
      history: { completeThrough: now, links: [], accounts: [f.owner, f.a, f.b].map(pair => ({
        principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [],
      })) },
    }),
    transport: {
      isShared: async (id, owner) => {
        if (advanceDuringLookup) f.tick();
        return shared && id === room && owner === f.owner.pub;
      },
      publish: async message => { published.push(message); },
    },
  });
  const prefix = createHash("sha256").update(f.a.pub).digest("hex").slice(0, 32);
  const message = { id: `s3rch:chat:${prefix}${randomBytes(16).toString("hex")}`, room,
    author: f.a.pub, body: "A bot reply", ts: at, v: 1 as const, actor: "bot" as const };
  const sig = await signForumRecord({ domain: "s3rch-room-chat/v1", ...message }, f.a);
  assert.ok(sig);
  const post = (token: string, body: unknown = { ...message, sig }) => reply(new Request("https://site.test/api/rooms/reply", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }));

  assert.equal((await post("other-scope")).status, 403);
  assert.equal((await post("room-scope")).status, 403);
  f.rows.push(writer);
  assert.equal((await post("room-scope", { ...message, sig, body: "edited" })).status, 403);
  shared = false;
  assert.equal((await post("room-scope")).status, 404);
  assert.equal(published.length, 0);
  shared = true;
  advanceDuringLookup = true;
  assert.equal((await post("room-scope")).status, 200);
  assert.equal(published.length, 1);

  await f.refresh();
  const reader = createRoomChatAdmission({ graph: f.auth.graph, parent: f.forum, readerKey: () => f.owner.pub, clock: f.now });
  const visible = await reader.receive(published[0], room, encodeKey(message.id));
  assert.equal(visible?.actor, "bot");
  assert.equal(visible?.body, message.body);
  assert.equal(await reader.receive({ ...published[0], actor: undefined }, room, encodeKey(message.id)), null);
});
