import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { seaToPrincipalKey } from "./identity/forum-check";
import vectors from "./identity/vectors/forum-authority.json";
import type { SeaPair } from "./identity/sea";
import { buildForumStatement } from "./forum-squad";
import { signForumRecord } from "./forum-sign";
import { toGunNode } from "./feed-types";
import { encodeBotMessage, parseBotMessage, type BotTaskMessage, type BotMessage } from "./forum-bot-protocol";
import { openForumBotChannel, type SignedBotStatement } from "./forum-bot-channel";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };

export async function forumBotFixture(t: test.TestContext) {
  const [owner, a, b] = await Promise.all([sea.pair(), sea.pair(), sea.pair()]);
  const tenant = randomUUID(), botA = randomUUID(), botB = randomUUID();
  const forum = `forum_${seaToPrincipalKey(owner.pub)}_${"a".repeat(32)}`;
  let at = 1700000060, consent = true, handles = true;
  const auth = createForumAuthority({ keys: [], pinnedIssuers: [], policy: vectors.context.policy }, () => at);
  const sign = (kind: AuthorityKind, value: object, signer = owner) => {
    const row = { issuedAt: at - 10, ...value, sig: "pending" };
    const parsed = parseForumAuthority(kind, row); assert.ok(parsed);
    row.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(signer.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
    return { kind, soul: parsed.soul, record: row };
  };
  const rows: ForumAuthoritySnapshot["rows"][number][] = [sign("object", { object: forum, owner: owner.pub })];
  for (const actor of [a.pub, b.pub]) for (const kind of ["see", "post"] as const)
    rows.push(sign(kind, { owner: owner.pub, object: forum, accessor: actor, stated: 1, hamState: 1, from: at - 20, until: at + 1000 }));
  async function refresh(allowed = rows) {
    const result = await auth.refresh({ completeThrough: at,
      history: { completeThrough: at, links: [], accounts: [owner, a, b].map(pair => ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) }, rows: allowed }, at);
    assert.ok(result.ok); assert.equal(result.diagnostics.length, 0);
  }
  await refresh();
  const dir = mkdtempSync(join(tmpdir(), "signed-bot-")); chmodSync(dir, 0o700);
  const clients: ReturnType<typeof openForumBotChannel>[] = [];
  const open = (bot: string = botB, changes = {}) => {
    const client = openForumBotChannel({ path: join(dir, bot + ".sqlite"),
      scope: { tenant, forum, bot, principal: bot === botA ? a.pub : b.pub }, owner: owner.pub,
      bots: { [botA]: a.pub, [botB]: b.pub }, rootSenders: [owner.pub], maxDelegationDepth: 2,
      authority: auth.graph, handleAllowed: () => handles, localConsent: () => consent, clock: () => at, ...changes });
    clients.push(client); return client;
  };
  t.after(() => { for (const c of clients) try { c.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const task = (bot: string = botB, parent: string | null = null, depth = 2): BotTaskMessage => ["task", tenant, randomUUID(), bot, randomUUID(), at + 100, parent, depth];
  async function signed(message: BotMessage, pair = owner, overrideForum = forum): Promise<SignedBotStatement> {
    const item = buildForumStatement({ forumId: overrideForum, author: pair.pub, body: encodeBotMessage(message), now: at, entropy: randomUUID().replaceAll("-", "") }); assert.ok(item);
    const signature = await signForumRecord(toGunNode(item), pair); assert.ok(signature);
    rows.push(sign("object", { object: item.id, owner: pair.pub }, pair));
    for (const actor of [owner.pub, a.pub, b.pub]) if (actor !== pair.pub)
      rows.push(sign("see", { owner: pair.pub, object: item.id, accessor: actor, stated: 1, hamState: 1, from: at - 20, until: at + 1000 }, pair));
    await refresh();
    return { id: item.id, author: item.author, issuedAt: item.ts, signature };
  }
  return { owner, a, b, botA, botB, tenant, forum, task, signed, open, rows, refresh, auth, now: () => at,
    setConsent(v: boolean) { consent = v; }, setHandles(v: boolean) { handles = v; }, tick() { at++; } };
}
