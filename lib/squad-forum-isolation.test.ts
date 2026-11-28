import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { p256 } from "@noble/curves/nist.js";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { createBotStatementAdmission } from "./forum-bot-statement-admission";
import { createForumAuthorityService } from "./forum-authority-service";
import { SEA_OWNED_FORUM_AUTHORITY } from "./sea-owned-forum-policy";
import { seaToPrincipalKey } from "./identity/forum-check";
import { mintSquadForumId } from "./squad-forum-mint";
import type { SeaPair } from "./identity/sea";

const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };

function mockSource(rows: ForumAuthoritySnapshot["rows"], accounts: string[]) {
  let snapshot: ForumAuthoritySnapshot = {
    completeThrough: 100,
    history: {
      completeThrough: 100,
      links: [],
      accounts: accounts.map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })),
    },
    rows: [...rows],
  };
  return {
    async read(_at?: number, _signal?: AbortSignal) {
      return { snapshot: structuredClone(snapshot), fence: "fence-1" };
    },
    async append(_fence: string, additions: ForumAuthoritySnapshot["rows"]) {
      snapshot = { ...snapshot, rows: [...snapshot.rows, ...additions.map(row => ({ ...row }))] };
      return true;
    },
  };
}

async function bootstrapForum(owner: SeaPair, forumId: string, at = 100) {
  const sign = (kind: AuthorityKind, fields: object) => {
    const row = { issuedAt: at - 10, ...fields, sig: "pending" };
    const parsed = parseForumAuthority(kind, row);
    assert.ok(parsed);
    row.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(owner.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
    return { kind, soul: parsed.soul, record: row };
  };
  return [
    sign("object", { object: forumId, owner: owner.pub }),
    sign("see", { owner: owner.pub, object: forumId, accessor: owner.pub, stated: 1, hamState: 1, from: at - 20, until: at + 1000 }),
    sign("post", { owner: owner.pub, object: forumId, accessor: owner.pub, stated: 1, hamState: 1, from: at - 20, until: at + 1000 }),
  ];
}

test("two owners cannot write each other's squad forums without a grant", async () => {
  const [ownerA, ownerB] = await Promise.all([sea.pair(), sea.pair()]);
  const forumA = mintSquadForumId(ownerA.pub, "a".repeat(32));
  const forumB = mintSquadForumId(ownerB.pub, "b".repeat(32));
  const rowsA = await bootstrapForum(ownerA, forumA);
  const rowsB = await bootstrapForum(ownerB, forumB);
  const source = mockSource([...rowsA, ...rowsB], [ownerA.pub, ownerB.pub]);
  const origin = "https://s3r.ch";
  const auth = (key: string) => async () => ({ key });
  const statements = createBotStatementAdmission({
    origin, config: SEA_OWNED_FORUM_AUTHORITY, authenticate: auth(ownerA.pub), source, clock: () => 100,
  });
  const authority = createForumAuthorityService({
    origin, config: SEA_OWNED_FORUM_AUTHORITY, authenticate: auth(ownerA.pub),
    read: async at => (await source.read(at, new AbortController().signal)).snapshot, clock: () => 100,
  });
  const graph = createForumAuthority(SEA_OWNED_FORUM_AUTHORITY, () => 100);
  const verified = await graph.refresh((await source.read(100, new AbortController().signal)).snapshot, 100);
  assert.ok(verified.ok);
  assert.equal(graph.graph.ownerOf(forumA), ownerA.pub);
  assert.equal(graph.graph.ownerOf(forumB), ownerB.pub);
  assert.equal(graph.graph.checkForumSee(forumA, ownerB.pub, 100).allowed, false);

  const object = `stmt_${seaToPrincipalKey(ownerB.pub)}_${"c".repeat(32)}`;
  const row = { issuedAt: 90, object, owner: ownerB.pub, sig: "pending" };
  const parsed = parseForumAuthority("object", row);
  assert.ok(parsed);
  row.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(ownerB.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
  const stmtRow = { kind: "object" as const, soul: parsed.soul, record: row };
  const bWriteA = await statements(new Request(origin + "/api/squad/statement", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, forumId: forumA, owner: ownerA.pub, evaluatedAt: 100, rows: [stmtRow] }),
  }));
  assert.equal(bWriteA.status, 403);

  const aReadB = await authority(new Request(origin + "/api/squad/authority", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: "ignored" },
    body: JSON.stringify({ version: 1, forumId: forumB, owner: ownerB.pub, evaluatedAt: 100 }),
  }));
  assert.equal(aReadB.status, 403);
});